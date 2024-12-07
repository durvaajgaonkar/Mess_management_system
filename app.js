import express from 'express';
import bodyParser from 'body-parser';
import session from 'express-session';
import bcrypt from 'bcrypt';
import dotenv from 'dotenv';
import multer from 'multer';
import path from 'path';
import Razorpay from 'razorpay';
import axios from 'axios';
import pg from 'pg';

dotenv.config();          
const db = new pg.Client({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

db.connect()
  .then(() => console.log('Connected to database'))
  .catch(err => console.error('Connection error', err.stack));

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, './public/uploads');
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 1024 * 1024 * 5 } 
});

const app = express();
const port = 3000;
const saltRounds = 10;

app.use(bodyParser.urlencoded({ extended: true }));
app.set('view engine', 'ejs');
app.set('views', './views');
app.use(express.static('public'));
app.use(express.json());

app.use(session({
  secret: process.env.SESSION_SECRET || 'your_secret_key',
  resave: false,
  saveUninitialized: true,
}));

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID, 
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

app.use((req, res, next) => {
  res.locals.cartCount = req.session.cart ? req.session.cart.length : 0;
  next(); 
});

app.get('/', (req, res) => {
  res.render('home');
});

app.get('/customer/login', (req, res) => {
  res.render('customer/customerLogin', { message: '' });
});

app.get('/register/customer', (req, res) => {
  const referral = req.query.ref || ''; 
  res.render('customer/customerRegister', { message: '', referral: referral });
});

app.get('/seller/login', (req, res) => {
  res.render('seller/sellerLogin', { message: '' });
});

app.get('/register/seller', (req, res) => {
  res.render('seller/sellerRegister', { message: '' });
});

app.get('/seller/bankDetails', async (req, res) => {
  const sellerId = req.session.sellerId; 
  const sellerName = req.session.sellerName;

  try {
    const result = await db.query('SELECT * FROM bank_details WHERE seller_id = $1', [sellerId]);
    const editMode = result.rows.length > 0;
    res.render('seller/bankDetails', {
      sellerName: sellerName,
      editMode: editMode, 
      message: '',
      bankDetails: result.rows[0] || {} 
    });
  } catch (error) {
    console.error('Error fetching bank details:', error);
    res.render('seller/bankDetails', { 
      sellerName: sellerName,
      message: 'Error fetching bank details. Please try again.',
      editMode: false, 
      bankDetails: {}
    });
  }
});

app.post('/seller/bankDetails', async (req, res) => {
  const sellerId = req.session.sellerId;
  const sellerName = req.session.sellerName;

  const { bankName, accHolderName, accNumber, IFSC, bank_branch, contact } = req.body;

  try {
    const result = await db.query('SELECT * FROM bank_details WHERE seller_id = $1', [sellerId]);
    const editMode = result.rows.length > 0; 

    if (editMode) {
      const updateQuery = 'UPDATE bank_details SET bank_name=$1, account_holder_name=$2, account_number=$3, ifsc_code=$4, bank_branch=$5, contact_number=$6 WHERE seller_id = $7';
      await db.query(updateQuery, [bankName, accHolderName, accNumber, IFSC, bank_branch, contact, sellerId]);
      res.redirect('/seller/home');
    } else {
      const insertQuery = 'INSERT INTO bank_details (seller_id, bank_name, account_holder_name, account_number, ifsc_code, bank_branch, contact_number) VALUES ($1, $2, $3, $4, $5, $6, $7)';
      await db.query(insertQuery, [sellerId, bankName, accHolderName, accNumber, IFSC, bank_branch, contact]);
      res.redirect('/seller/home');
    }
  } catch (error) {
    console.error('Error adding/updating bank details:', error);
    const result = await db.query('SELECT * FROM bank_details WHERE seller_id = $1', [sellerId]);
    const editMode = result.rows.length > 0; 
    res.render('seller/bankDetails', {
      sellerName: sellerName,
      message: 'Error adding/updating bank details. Please try again.',
      editMode: editMode, 
      bankDetails: { bank_name: bankName, account_holder_name: accHolderName, account_number: accNumber, ifsc_code: IFSC, bank_branch: bank_branch, contact_number: contact } // Keep user input
    });
  }
});

const isAuthenticatedSeller = (req, res, next) => {
  if (req.session.sellerId) {
    return next(); 
  } else {
    return res.redirect('/seller/login'); 
  }
};

const isAuthenticatedCustomer = (req, res, next) => {
  if (req.session.customerId) {
    return next(); 
  } else {
    return res.redirect('/customer/login'); 
  }
};

app.post('/register/customer', async (req, res) => {
  const { name, address, email, password, confirmpassword, referral } = req.body;

  if (password !== confirmpassword) {
    return res.render('customer/customerRegister', { message: 'Passwords do not match.', referral: referral });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    // Check if the email already exists
    db.query('SELECT * FROM customers WHERE email = $1', [email], (err, result) => {
      if (err) {
        console.error('Error during registration:', err);
        return res.render('customer/customerRegister', { message: 'Error during registration. Please try again.', referral: referral });
      } else if (result.rows.length > 0) {
        return res.render('customer/customerRegister', { message: 'User already exists. Please try a different one.', referral: referral });
      } else {
        const isReferral = referral ? true : false;
        const referrerId = referral || null; // If referral is present, set referrerId; otherwise, null
        console.log(referrerId);
        db.query(
          'INSERT INTO customers (name, address, email, password, is_referral, referrer_id) VALUES ($1, $2, $3, $4, $5, $6)',
          [name, address, email, hashedPassword, isReferral, referrerId],
          (err, result) => {
            if (err) {
              console.error('Error registering customer:', err);
              return res.render('customer/customerRegister', { message: 'Error during registration. Please try again.', referral: referral });
            } else {
              if (referrerId) {
                db.query('SELECT * FROM customers WHERE id = $1', [referrerId], async (err, referrerResult) => {
                  if (err) {
                    console.error('Error fetching referrer:', err);
                    return res.render('customer/customerRegister', { message: 'Error processing referral. Please try again.', referral: referral });
                  } else if (referrerResult.rows.length > 0) {
                    const couponCode = generateCouponCode(6); // A function to generate a 6-character coupon

                    db.query(
                      'UPDATE customers SET coupon = $1 WHERE id = $2',
                      [couponCode, referrerId],
                      (err) => {
                        if (err) {
                          console.error('Error updating referrer with coupon:', err);
                        } else {
                          console.log(`Coupon generated and stored for the referrer: ${couponCode}`);
                        }
                      }
                    );
                  }
                });
              }
              res.redirect('/customer/login');
            }
          }
        );
      }
    });
  } catch (error) {
    console.error('Error during registration:', error);
    res.render('customer/customerRegister', { message: 'Error during registration. Please try again.', referral: referral });
  }
});

app.post('/customer/login', async (req, res) => {
  const { email, password } = req.body;

  db.query('SELECT * FROM customers WHERE email = $1', [email], async (err, result) => {
    if (err) {
      console.error('Error during customer login:', err);
      return res.render('customer/customerLogin', { message: 'Error during login. Please try again.' });
    }
    if (result.rows.length > 0) {
      const user = result.rows[0];
      const match = await bcrypt.compare(password, user.password);
      if (match) {
        req.session.customerId = user.id;
        req.session.customerName = user.name;
        res.redirect('/customer/home');
      } else {
        res.render('customer/customerLogin', { message: 'Invalid credentials. Please try again.' });
      }
    } else {
      res.render('customer/customerLogin', { message: 'User does not exist. Please register.' });
    }
  });
});

app.get('/customer/refer', isAuthenticatedCustomer, async (req, res) => {
  try {
    const customerId = req.session.customerId;
    
    // Generate a referral link with the customer's ID
    const referralLink = `${req.protocol}://${req.get('host')}/register/customer?ref=${customerId}`;

    res.render('customer/refer', {
      customerName: req.session.customerName,
      referralLink: referralLink,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

app.post('/register/seller', async (req, res) => {
  const { name, address, email, password, confirmpassword, phone } = req.body;
  if (password !== confirmpassword) {
    return res.render('seller/sellerRegister', { message: 'Passwords do not match.' });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    db.query('SELECT * FROM sellers WHERE email = $1', [email], (err, result) => {
      if (err) {
        console.error('Error during registration:', err);
        return res.render('seller/sellerRegister', { message: 'Error during registration. Please try again.' });
      } else if (result.rows.length > 0) {
        return res.render('seller/sellerRegister', { message: 'User already exists. Please try a different one.' });
      } else {
        db.query('INSERT INTO sellers (name, address, email, password, phone_number) VALUES ($1, $2, $3, $4, $5)', 
          [name, address, email, hashedPassword, phone], (err) => {
          if (err) {
            console.error('Error registering:', err);
            return res.render('seller/sellerRegister', { message: 'Error during registration. Please try again.' });
          } else {
            res.redirect('/seller/login');
          }
        });
      }
    });
  } catch (error) {
    console.error('Error hashing password:', error);
    res.render('seller/sellerRegister', { message: 'Error during registration. Please try again.' });
  }
});

app.post('/seller/login', async (req, res) => {
  const { email, password } = req.body;

  db.query('SELECT * FROM sellers WHERE email = $1', [email], async (err, result) => {
    if (err) {
      console.error('Error during seller login:', err);
      return res.render('seller/sellerLogin', { message: 'Error during login. Please try again.' });
    }
    if (result.rows.length > 0) {
      const user = result.rows[0];
      const match = await bcrypt.compare(password, user.password);
      if (match) {
        req.session.sellerId = user.id;
        req.session.sellerName = user.name;
        res.redirect('/seller/home');
      } else {
        res.render('seller/sellerLogin', { message: 'Invalid credentials. Please try again.' });
      }
    } else {
      res.render('seller/sellerLogin', { message: 'User does not exist. Please register.' });
    }
  });
});

app.get('/customer/home', isAuthenticatedCustomer, (req, res) => {
  const customerId = req.session.customerId;
  const customerName = req.session.customerName;

  db.query('SELECT id, name, address, rating FROM sellers', (err, result) => {
    if (err) {
      console.error('Error fetching sellers:', err);
      return res.render('customer/customerHome', { customerName, message: 'Error fetching sellers. Please try again.', sellers: [] });
    }

    res.render('customer/customerHome', {
      customerName: customerName,
      sellers: result.rows,
      message: ''
    });
  });
});

app.get('/seller/home', isAuthenticatedSeller, (req, res) => {
  const sellerId = req.session.sellerId;
  const sellerName = req.session.sellerName;

  res.render('seller/sellerHome', {
    sellerId: sellerId,
    sellerName: sellerName,
    message:''
  });
});

app.post('/rate-seller/:id/:rating', (req, res) => {
  const sellerId = req.params.id;
  let newRating = parseFloat(req.params.rating);

  if (isNaN(newRating)) {
    newRating = 0;
  }

  db.query('SELECT rating, rating_count FROM sellers WHERE id = $1', [sellerId], (err, result) => {
    if (err) {
      console.error('Error fetching seller:', err);
      return res.json({ success: false });
    }

    const seller = result.rows[0];
    const currentRating = seller.rating || 0;
    const ratingCount = seller.rating_count || 0;

    const updatedRating = ((currentRating * ratingCount) + newRating) / (ratingCount + 1);

    db.query('UPDATE sellers SET rating = $1, rating_count = $2 WHERE id = $3', 
      [parseFloat(updatedRating.toFixed(1)), ratingCount + 1, sellerId], (err) => {
      if (err) {
        console.error('Error updating rating:', err);
        return res.json({ success: false });
      }
      res.json({ success: true });
    });
  });
});

app.get('/add-meal', isAuthenticatedSeller, (req, res) => {
  const sellerName = req.session.sellerName; 
  res.render('seller/sellerHome', { sellerName, message: '' });
});

app.post('/add-meal', isAuthenticatedSeller, upload.single('meal_image'), (req, res) => {
  const { name, price, contents, prep_time, isMonthly } = req.body; // Add isMonthly here
  const sellerId = req.session.sellerId;
  const sellerName = req.session.sellerName;

  const mealImage = req.file ? `/uploads/` + req.file.filename : null;

  if (!mealImage) {
    return res.render('seller/sellerHome', { sellerName, message: 'Meal image is required.' });
  }

  db.query('INSERT INTO meals (seller_id, seller_name, name, price, contents, prep_time, image_url, isMonthly) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', 
    [sellerId, sellerName, name, price, contents, prep_time, mealImage, isMonthly], // Include isMonthly
    (err) => {
    if (err) {
      console.error('Error adding meal:', err);
      return res.render('seller/sellerHome', { message: 'Error adding meal. Please try again.', sellerName });
    }
    res.render('seller/sellerHome', { message: 'Meal added successfully', sellerName });
  });
});

app.get('/view-meals', isAuthenticatedSeller, (req, res) => {
  const sellerId = req.session.sellerId;
  const sellerName = req.session.sellerName;
  db.query('SELECT * FROM meals WHERE seller_id = $1', [sellerId], (err, result) => {
    if (err) {
      console.error('Error fetching meals:', err);
      return res.redirect('/seller/sellerHome');
    }
    res.render('seller/viewMeals', { meals: result.rows, sellerName });
  });
});

app.get('/update-meal/:id', isAuthenticatedSeller, (req, res) => {
  const { id } = req.params;
  const sellerName = req.session.sellerName;
  db.query('SELECT * FROM meals WHERE id = $1', [id], (err, result) => {
    if (err) {
      console.error('Error fetching meal for update:', err);
      return res.redirect('/view-meals');
    }
    if (result.rows.length > 0) {
      res.render('seller/updateMeal',{ meal: result.rows[0], sellerName });
    } else {
      res.redirect('/view-meals'); 
    }
  });
});

app.post('/update-meal', isAuthenticatedSeller, upload.single('meal_image'), (req, res) => {
  const { id, name, price, contents, prep_time } = req.body;
  let mealImage = req.file ? `/uploads/` +req.file.filename : null ; 
  const getMealQuery = 'SELECT image_url FROM meals WHERE id = $1';
  db.query(getMealQuery, [id], (err, result) => {
    if (err) {
      console.error('Error fetching meal:', err);
      return res.render('seller/updateMeal', { message: 'Error fetching meal. Please try again.', meal: { id, name, price, contents, prep_time }, sellerName });
    }

    const oldImageUrl = result.rows.length > 0 ? result.rows[0].image_url : null;
    
    mealImage = mealImage || oldImageUrl;

    const updateMealQuery = 'UPDATE meals SET name = $1, price = $2, contents = $3, prep_time = $4, image_url = $5 WHERE id = $6';
    db.query(updateMealQuery, [name, price, contents, prep_time, mealImage, id], (err) => {
      if (err) {
        console.error('Error updating meal:', err);
        return res.render('seller/updateMeal', { message: 'Error updating meal. Please try again.', meal: { id, name, price, contents, prep_time }, sellerName });
      }
      res.redirect('/view-meals');
    });
  });
});

app.post('/delete-meal/:id', isAuthenticatedSeller, (req, res) => {
  const { id } = req.params;
  const sellerName = req.session.sellerName; 
  db.query('DELETE FROM meals WHERE id = $1', [id], (err) => {
    if (err) {
      console.error('Error deleting meal:', err);
      return res.render('seller/deleteMeal', { message: 'Error deleting meal. Please try again.', meal: { id } ,sellerName});
    }
    res.redirect('/view-meals');
  });
});

app.get('/view-seller-meals/:id', (req, res) => {
  const sellerId = req.params.id;
  const customerName = req.session.customerName;
  const cartCount = req.session.cart ? req.session.cart.length : 0;

  db.query('SELECT * FROM meals WHERE seller_id = $1 AND is_enabled = true', [sellerId], (err, result) => {
    if (err) {
      console.error('Error fetching meals:', err);
      return res.render('customer/viewAllSellers', { message: 'Error fetching meals. Please try again.', customerName });
    }

    db.query('SELECT * FROM sellers WHERE id = $1', [sellerId], (err, sellerResult) => {
      if (err) {
        console.error('Error fetching seller:', err);
        return res.render('customer/viewAllSellers', { message: 'Error fetching seller. Please try again.', customerName });
      }

      const seller = sellerResult.rows[0];
      res.render('customer/viewSellerMeals', { meals: result.rows, seller, customerName, cartCount });
    });
  });
});

app.post('/toggle-meal-status/:id', (req, res) => {
  const mealId = req.params.id;

  db.query('SELECT is_enabled FROM meals WHERE id = $1', [mealId], (err, result) => {
    if (err || result.rows.length === 0) {
      console.error('Error fetching meal:', err);
      return res.redirect('/seller/home'); 
    }

    const currentStatus = result.rows[0].is_enabled;
    const newStatus = !currentStatus; 

    db.query('UPDATE meals SET is_enabled = $1 WHERE id = $2', [newStatus, mealId], (err) => {
      if (err) {
        console.error('Error updating meal status:', err);
        return res.redirect('/seller/home');
      }
      res.redirect('/view-meals'); 
    });
  });
});

app.get('/cart', isAuthenticatedCustomer, (req, res) => {
  const customerName = req.session.customerName;
  const cartItems = req.session.cart ? req.session.cart : [];
  const cartCount = cartItems.length;

  res.render('customer/cart', { customerName, cartItems, cartCount });
});

app.post('/cart/add', (req, res) => {
  const mealId = req.body.mealId;
  const mealName = req.body.mealName;
  const mealPrice= req.body.mealPrice;
  const mealContents = req.body.mealContents;
  const mealPrep=req.body.mealPrep;
  const mealSeller=req.body.mealSeller;
  const mealImage=req.body.mealImage;
  const mealSellerId=req.body.mealSellerId;

  if (!req.session.cart) {
    req.session.cart = [];
  }
  req.session.cart.push({
    id: mealId,
    name: mealName,
    price: mealPrice,
    contents: mealContents,
    prep_time: mealPrep,
    seller_name: mealSeller,
    image_url: mealImage,
    seller_id: mealSellerId // Make sure sellerId is passed here
  });
  res.json({ cartCount: req.session.cart.length });
});

app.post('/add-to-cart/:mealId', isAuthenticatedCustomer, (req, res) => {
  const mealId = req.params.mealId;

  db.query('SELECT * FROM meals WHERE id = $1', [mealId], (err, result) => {
    if (err || result.rows.length === 0) {
      return res.redirect('/view-seller-meals/' + req.session.sellerId);
    }
    const meal = result.rows[0];
    if (!req.session.cart) {
      req.session.cart = [];
    }
    if (!req.session.cart.some(item => item.id === meal.id)) {
      req.session.cart.push({
        id: meal.id,
        name: meal.name,
        price: meal.price,
        contents: meal.contents,
        prep_time: meal.prep_time,
        seller_name: meal.seller_name,
        image_url: meal.image_url 
      });
    }

    res.redirect('/cart');
  });
});

app.post('/remove-from-cart/:id', (req, res) => {
  const mealId = req.params.id;
  if (req.session.cart) {
    req.session.cart = req.session.cart.filter(item => item.id !== mealId);
  }
  res.redirect('/cart');
});

app.get('/order/:mealId', isAuthenticatedCustomer, async (req, res) => {
  const mealId = req.params.mealId;
  const customerId = req.session.customerId;

  try {
    const mealQuery = `
      SELECT m.*, s.id AS seller_id, s.address AS seller_address, s.name AS seller_name 
      FROM meals m 
      JOIN sellers s ON m.seller_id = s.id 
      WHERE m.id = $1
    `;

    const mealResult = await db.query(mealQuery, [mealId]);
    if (mealResult.rows.length === 0) {
      return res.redirect('/customer/home');
    }

    const customerResult = await db.query('SELECT address FROM customers WHERE id = $1', [customerId]);
    if (customerResult.rows.length === 0) {
      return res.redirect('/customer/home');
    }

    const meal = mealResult.rows[0];
    const customerLocation = customerResult.rows[0].address || 'Not specified';

    req.session.sellerId = meal.seller_id; 
    req.session.mealName = meal.name;      
    req.session.orderAmount = meal.price; 
    req.session.deliveryAddress = customerLocation; 

    res.render('customer/ordernow', {
      customerName: req.session.customerName,
      meal: meal,
      customerLocation: customerLocation,
      cartCount: req.session.cart ? req.session.cart.length : 0
    });
  } catch (error) {
    console.error('Error in order retrieval:', error);
    return res.redirect('/customer/home');
  }
});

const OPEN_ROUTE_SERVICE_API_KEY = '5b3ce3597851110001cf624829d0f33cfb5945af9eca6affb37f167b';

async function geocodeAddress(address) {
  try {
    const response = await axios.get('https://api.openrouteservice.org/geocode/search', {
      params: {
        text: address,
        country: 'IN' 
      },
      headers: {
        Authorization: OPEN_ROUTE_SERVICE_API_KEY
      }
    });

    if (response.data.features.length > 0) {
      const coordinates = response.data.features[0].geometry.coordinates;
      return { longitude: coordinates[0], latitude: coordinates[1] };
    } else {
      throw new Error('No coordinates found for the address.');
    }
  } catch (error) {
    console.error('Error geocoding address:', error);
    throw error;
  }
}

async function calculateDistance(sellerAddress, customerAddress) {
  try {
    const sellerCoordinates = await geocodeAddress(sellerAddress);
    const customerCoordinates = await geocodeAddress(customerAddress);

    console.log(`Calculating distance from ${sellerCoordinates.latitude}, ${sellerCoordinates.longitude} to ${customerCoordinates.latitude}, ${customerCoordinates.longitude}`);

    console.log('Using API Key:', OPEN_ROUTE_SERVICE_API_KEY);

    const distanceResponse = await axios.get(`https://api.openrouteservice.org/v2/directions/driving-car`, {
      params: {
        start: `${sellerCoordinates.latitude},${sellerCoordinates.longitude}`,
        end: `${customerCoordinates.latitude},${customerCoordinates.longitude}`
      },
      headers: {
        'Authorization': OPEN_ROUTE_SERVICE_API_KEY
      }
    });

    return distanceResponse.data.routes[0].summary.distance; 
  } catch (error) {
    if (error.response) {
      console.error('Error details:', error.response.data);
    } else {
      console.error('Error calculating distance:', error);
    }
    throw error;
  }
}

function getDeliveryCharge(distance) {
  if (distance <= 5000) { 
    return 50;  
  } else if (distance <= 10000) {
    return 100;  
  } else {
    return 150;  
  }
}

app.post('/calculate-distance', async (req, res) => {
  const { sellerAddresses, deliveryAddress } = req.body;

  if (!sellerAddresses || !deliveryAddress) {
    return res.status(400).json({ error: 'Seller and delivery addresses are required' });
  }

  try {
    let totalDeliveryCharge = 0;

    for (const sellerAddress of sellerAddresses) {
      const distance = await calculateDistance(sellerAddress, deliveryAddress);
      console.log(`Distance from ${sellerAddress} to ${deliveryAddress}: ${distance} meters`);
      totalDeliveryCharge += getDeliveryCharge(distance);
    }

    return res.json({ totalDeliveryCharge });
  } catch (error) {
  //  console.error('Error calculating distance:', error);
    console.error('Error calculating distance.');
    return res.status(500).json({ error: 'Error calculating distance' });
  }
});

app.get('/geocode', async (req, res) => {
  const { address } = req.query; 

  if (!address) {
    return res.status(400).json({ error: 'Address is required' });
  }

  try {
    const response = await axios.get(`https://api.openrouteservice.org/geocode/search`, {
      headers: {
        'Authorization': OPEN_ROUTE_SERVICE_API_KEY,
      },
      params: {
        text: address,
        country: 'IN',
      },
    });

    const data = response.data;
    if (data.features && data.features.length > 0) {
      const { coordinates } = data.features[0].geometry;
      return res.json({ longitude: coordinates[0], latitude: coordinates[1] });
    } else {
      return res.status(404).json({ error: 'No geocoding results found' });
    }
  } catch (error) {
    console.error('Error geocoding address:', error);
    return res.status(500).json({ error: 'Error geocoding address' });
  }
});

app.post('/checkout', isAuthenticatedCustomer, async (req, res) => {
  const customerId = req.session.customerId;  
  const customerName = req.session.customerName;
  const cartItems = req.session.cart || [];

  if (cartItems.length === 0) {
    return res.redirect('/cart');
  }

  try {
    const result = await db.query('SELECT address FROM customers WHERE id = $1', [customerId]);
    const customerLocation = result.rows[0].address || 'Not specified';

    res.render('customer/orderCart', {
      cartItems,
      customerName,
      customerLocation 
    });
  } catch (err) {
    console.error('Error fetching customer address:', err);
    return res.redirect('/cart');
  }
});


app.get('/payment-confirmations', isAuthenticatedCustomer, async (req, res) => {
  const customerName = req.session.customerName;
  const cart = req.session.cart || [];
  const sellerInfo = {}; // To store seller names and phone numbers

  // Retrieve seller names and phone numbers for each meal in the cart
  for (const meal of cart) {
    const sellerQuery = 'SELECT name, phone_number FROM sellers WHERE id = $1';
    const sellerResult = await db.query(sellerQuery, [meal.seller_id]);
    if (sellerResult.rows.length > 0) {
      sellerInfo[meal.seller_id] = sellerResult.rows[0]; // Store both name and phone number
    }
  }

  res.render('customer/payment-confirmations', { customerName, sellerInfo });
});


app.get('/payment-confirmations', isAuthenticatedCustomer, async (req, res) => {
  const customerName = req.session.customerName;
  const cart = req.session.cart || [];
  const sellerPhoneNumbers = {};

  // Retrieve seller phone numbers for each meal in the cart
  for (const meal of cart) {
    const sellerPhoneQuery = 'SELECT phone_number FROM sellers WHERE id = $1';
    const sellerPhoneResult = await db.query(sellerPhoneQuery, [meal.seller_id]);
    if (sellerPhoneResult.rows.length > 0) {
      sellerPhoneNumbers[meal.seller_id] = sellerPhoneResult.rows[0].phone_number;
    }
  }

  res.render('customer/payment-confirmations', { customerName, sellerPhoneNumbers });
});

app.post('/payment-confirmations', async (req, res) => {
  const { paymentId, orderId } = req.body;
  const { customerId, deliveryAddress, cart } = req.session;
  const orderDate = new Date();
  const orderStatus = 'Delivered';

  if (!customerId || !cart || cart.length === 0 || !deliveryAddress) {
    return res.status(400).json({ error: 'Missing required values' });
  }

  try {
    for (const meal of cart) {
      const query = `
        INSERT INTO order_history (customer_id, seller_id, meal_name, order_amount, order_status, order_date, delivery_address)
        VALUES ($1, $2, $3, $4, $5, $6, $7);
      `;
      const values = [
        customerId,
        meal.seller_id,
        meal.name,
        meal.price,
        orderStatus,
        orderDate,
        deliveryAddress
      ];
      await db.query(query, values);
    }

    // Existing referral logic
    const referralCheckQuery = 'SELECT referrer_id FROM customers WHERE id = $1';
    const referralCheckResult = await db.query(referralCheckQuery, [customerId]);
    if (referralCheckResult.rows.length > 0 && referralCheckResult.rows[0].referrer_id) {
      const referrerId = referralCheckResult.rows[0].referrer_id;
      const firstOrderCheckQuery = 'SELECT COUNT(*) AS orderCount FROM order_history WHERE customer_id = $1';
      const firstOrderCheckResult = await db.query(firstOrderCheckQuery, [customerId]);

      if (firstOrderCheckResult.rows[0].orderCount === 0) {
        const couponCode = generateCouponCode();
        const updateCouponQuery = 'UPDATE customers SET coupon = $1 WHERE id = $2';
        await db.query(updateCouponQuery, [couponCode, referrerId]);
        notifyReferrer(referrerId, couponCode);
        console.log(`Coupon generated and stored for the referrer (Customer A): ${couponCode}`);
      }
    }

    // Existing fund transfer logic
    for (const [sellerId, amount] of Object.entries(req.session.sellerAmounts)) {
      const bankDetailsQuery = 'SELECT * FROM bank_details WHERE seller_id = $1';
      const bankDetailsResult = await db.query(bankDetailsQuery, [sellerId]);

      if (bankDetailsResult.rows.length > 0) {
        const { bank_name, account_number, ifsc_code } = bankDetailsResult.rows[0];
        await transferFundsToSeller(account_number, ifsc_code, amount);
      }
    }
    req.session.cart = [];
    req.session.sellerAmounts = {};
    console.log('Order placed and payments distributed successfully');
    res.redirect('/payment-confirmation');
  } catch (err) {
    console.error('Error processing payment confirmation:', err);
    res.status(500).json({ error: 'Error processing payment confirmation' });
  }
});


app.post('/payment-confirmation', async (req, res) => {
  const { paymentId, orderId } = req.body;
  const customerId = req.session.customerId;
  const sellerId = req.session.sellerId;
  const mealName = req.session.mealName;
  const orderAmount = req.session.orderAmount;
  const deliveryAddress = req.session.deliveryAddress;
  const orderDate = new Date();
  const orderStatus = 'Delivered';

  console.log('Session values before order creation:', {
    customerId,
    sellerId,
    mealName,
    orderAmount,
    deliveryAddress
  });

  if (!customerId || !sellerId || !mealName || !orderAmount || !deliveryAddress) {
    console.error('Missing required values:', { customerId, sellerId, mealName, orderAmount, deliveryAddress });
    return res.status(400).json({ error: 'Missing required values to save order' });
  }

  const query = `
    INSERT INTO order_history (customer_id, seller_id, meal_name, order_amount, order_status, order_date, delivery_address)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING id;
  `;
  const values = [customerId, sellerId, mealName, orderAmount, orderStatus, orderDate, deliveryAddress];

  try {
    const result = await db.query(query, values);
    console.log('Order saved successfully:', result.rows[0]);

    const sellerPhoneQuery = 'SELECT phone_number FROM sellers WHERE id = $1';
    const sellerPhoneResult = await db.query(sellerPhoneQuery, [sellerId]);
    const sellerPhoneNumber = sellerPhoneResult.rows.length > 0 ? sellerPhoneResult.rows[0].phone_number : null;

    const customerQuery = `SELECT is_referral, referrer_id FROM customers WHERE id = $1`;
    const customerValues = [customerId];
    const customerResult = await db.query(customerQuery, customerValues);

    if (customerResult.rows.length > 0) {
      const customer = customerResult.rows[0];
      if (customer.is_referral) {
        const referrerId = customer.referrer_id;

        if (referrerId) {
          const couponCode = generateCouponCode();
          await db.query(`UPDATE customers SET coupon = $1 WHERE id = $2`, [couponCode, referrerId]);
          notifyReferrer(referrerId, couponCode);
          console.log('Coupon generated and stored for the referrer:', couponCode);
        }
      }
    }
    res.redirect('/payment-confirmation');
  } catch (err) {
    console.error('Error processing payment confirmation:', err);
    res.status(500).json({ error: 'Error processing payment confirmation' });
  }
});

function generateCouponCode(length = 6) {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let couponCode = '';
  for (let i = 0; i < length; i++) {
    couponCode += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return couponCode;
}

async function notifyReferrer(referrerId, couponCode) {
  console.log(`Notifying referrer ${referrerId} about coupon: ${couponCode}`);
}

app.post('/save-delivery-address', isAuthenticatedCustomer, (req, res) => {
  const { address } = req.body;

  if (!address) {
    return res.status(400).json({ error: 'No delivery address provided' });
  }
  req.session.deliveryAddress = address;

  const orderId = "GENERATED_RAZORPAY_ORDER_ID"; 

  res.json({ orderId }); 
});

async function transferFundsToSeller(accountNumber, ifscCode, amount) {
  const options = {
    bank_account: {
      account_number: accountNumber,
      ifsc_code: ifscCode
    },
    amount: amount * 100, 
    currency: 'INR',
  };

  try {
    const response = await razorpay.payouts.create(options);
    console.log('Payout successful:', response);
  } catch (error) {
    console.error('Error during payout:', error);
    throw error; 
  }
}

app.post('/create-orders', (req, res) => {
  const { address, totalAmount } = req.body;
  if (!req.session.cart || req.session.cart.length === 0) {
    return res.status(400).json({ error: 'Cart is empty' });
  }
  req.session.deliveryAddress = address;
  if (!totalAmount || isNaN(totalAmount)) {
    return res.status(400).json({ error: 'Invalid total amount' });
  }
  console.log('Session data before Razorpay order creation:', {
    customerId: req.session.customerId,
    cart: req.session.cart,
    totalAmount,
    deliveryAddress: req.session.deliveryAddress
  });

  const options = {
    amount: totalAmount, 
    currency: "INR",
    receipt: "receipt_order_74394",
    payment_capture: 1
  };

  razorpay.orders.create(options, function (err, order) {
    if (err) {
      console.error('Error creating Razorpay order:', err);
      return res.status(500).json({ error: 'Error creating Razorpay order' });
    }
    res.json(order); 
  });
});

app.post('/create-order', async (req, res) => {
  const { amount, address, cart } = req.body;

  if (!amount || !address || !cart || cart.length === 0) {
    return res.status(400).json({ error: 'Amount, address, and cart are required' });
  }

  const sellerIds = [...new Set(cart.map(item => item.sellerId))]; // Get unique seller IDs

  // If there's more than one seller, handle accordingly
  if (sellerIds.length > 1) {
    console.error('Multiple sellers detected:', sellerIds);
    return res.status(400).json({ error: 'Cannot process orders from multiple sellers at this time.' });
  }

  const options = {
    amount: amount,
    currency: "INR",
    receipt: "receipt_order_74394",
    payment_capture: 1
  };

  try {
    const order = await razorpay.orders.create(options);
    
    // Store necessary values in the session for later use
    req.session.customerId = req.session.customerId; // Assuming you set this on login
    req.session.sellerId = sellerIds[0]; // Store the single sellerId
    req.session.mealName = cart.map(item => item.mealName).join(", "); // Join meal names if multiple
    req.session.orderAmount = cart.reduce((total, item) => total + item.orderAmount, 0); // Sum order amounts
    req.session.deliveryAddress = address;

    res.json(order); 
  } catch (err) {
    console.error('Error creating order:', err);
    return res.status(500).json({ error: 'Error creating order' });
  }
});

app.get('/monthly-payment-confirmation', (req, res) => {
  const customerName = req.session.customerName;
  res.render('customer/monthly-payment-confirmation', { customerName });
});

app.post('/create-monthly-order', async (req, res) => {
  const { amount, sellerId, mealName, mealPlan, deliveryAddress } = req.body;
  req.session.sellerId = sellerId;
  req.session.mealName = mealName;
  req.session.mealPlan = mealPlan;
  req.session.deliveryAddress = deliveryAddress;
  if (!amount) {
    return res.status(400).json({ error: 'Amount is required.' });
  }

  try {
    const paymentOptions = {
      amount: amount,
      currency: 'INR',
      receipt: `monthly_${sellerId}`,
      payment_capture: 1,
    };

    const payment = await razorpay.orders.create(paymentOptions);

    req.session.orderAmount = amount; 
    res.json({ id: payment.id, amount: payment.amount });
  } catch (err) {
    console.error('Error creating monthly order:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/monthly-payment-confirmation', async (req, res) => {
  const customerId = req.session.customerId;
  const customerName = req.session.customerName;
  const sellerId = req.session.sellerId;
  const mealName = req.session.mealName;
  const mealPlan = req.session.mealPlan;
  const deliveryAddress = req.session.deliveryAddress;
  let orderAmount = req.session.orderAmount; 
  orderAmount = parseFloat(orderAmount);
  // Ensure all required data is present
  if (!customerId || !sellerId || !mealName || isNaN(orderAmount) || !deliveryAddress) {
      console.error('Missing required values:', { customerId, sellerId, mealName, orderAmount, deliveryAddress });
      return res.status(400).json({ error: 'Missing required values to save order' });
  }
  try {
    const query = `
      INSERT INTO monthly (customer_id, seller_id, customer_name, meal_name, meal_plan, delivery_address, price)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `;
    const values = [
      customerId,
      sellerId,
      customerName.trim(), // Remove any extra whitespace
      mealName,
      mealPlan,
      deliveryAddress,
      orderAmount/100,
    ];
    const results = await db.query(query, values);
    res.json({ success: true, orderId: results.insertId });
} catch (err) {
    console.error('Error processing payment confirmation:', err);
    res.status(500).json({ error: 'Error processing payment confirmation' });
}
});

app.get('/monthly/:sellerId', async (req, res) => { 
  try {
    const sellerId = req.params.sellerId;
    const customerId = req.session.customerId; 
    const customerName = req.session.customerName;

    // Fetch seller information
    const sellerQuery = await db.query('SELECT id, name FROM sellers WHERE id = $1', [sellerId]);
    const seller = sellerQuery.rows[0];

    // Check if the seller exists
    if (!seller) {
      return res.status(404).send('Seller not found');
    }
    const mealsQuery = await db.query('SELECT id, name, price FROM meals WHERE seller_id = $1 AND isMonthly = $2', [sellerId, 'yes']);

    const meals = mealsQuery.rows;
    console.log('Seller:', seller);
    console.log('Meals:', meals);
    // Render the monthly page with seller and meals
    res.render('customer/monthly', { seller, meals, customerId, customerName });
  } catch (err) {
    console.error('Error fetching monthly meals:', err);
    res.status(500).send('Server error');
  }
});

app.post('/monthly/submit', async (req, res) => {
  const { customerName, mealName, mealPlan, deliveryAddress } = req.body;

  try {
    const customerId = req.session.customerId;
    const customerName = req.session.customerName;

    const result = await db.query(
      'INSERT INTO monthly (customer_id, customer_name, meal_name, meal_plan, delivery_address) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [customerId, customerName, mealName, mealPlan, deliveryAddress]
    );

    const monthlyId = result.rows[0].id;

    // Calculate total price for 30 days without discount
    const mealPrice = await db.query('SELECT price FROM meals WHERE id = $1', [mealName]);
    const totalMealPrice = mealPrice.rows[0].price * 30; // Price for 30 days

    const paymentOptions = {
      amount: totalMealPrice * 100, // Amount in paise
      currency: 'INR',
      receipt: `monthly_${monthlyId}`,
      payment_capture: 1,
    };

    const payment = await razorpay.orders.create(paymentOptions);
    res.json({ orderId: payment.id });

  } catch (err) {
    console.error('Error processing monthly meal plan:', err);
    res.status(500).send('Server Error');
  }
});

app.get('/customer/mess', isAuthenticatedCustomer, async (req, res) => {
  try {
      const customerId = req.session.customerId;
      const result = await db.query(`
        SELECT 
            monthly.id,
            sellers.name AS seller_name,
            monthly.meal_plan,
            monthly.status,
            monthly.meal_name, 
            monthly.price,                -- Add price
            monthly.created_at            -- Add order date
        FROM 
            monthly
        JOIN 
            sellers 
        ON 
            monthly.seller_id = sellers.id
        WHERE 
            monthly.customer_id = $1
    `, [customerId]);
    
      const monthlyMess = result.rows;

      res.render('customer/mess', {
          monthlyMess: monthlyMess,
          customerName: req.session.customerName,
      });
  } catch (err) {
      console.error(err);
      res.status(500).send('Server Error');
  }
});

app.get('/customer/orders', async (req, res) => {
  const customerId = req.session.customerId;
  const customerName = req.session.customerName;

  if (!customerId) {
    return res.status(401).send('Unauthorized: Please log in to view your orders.');
  }

  try {
    const query = `
      SELECT 
        oh.id, 
        oh.meal_name, 
        oh.order_amount, 
        oh.order_status, 
        oh.order_date, 
        s.name AS seller_name,
        m.prep_time AS prep_time 
      FROM 
        order_history oh
      JOIN 
        sellers s ON oh.seller_id = s.id 
      JOIN 
        meals m ON oh.meal_name = m.name 
      WHERE 
        oh.customer_id = $1 
      ORDER BY 
        oh.order_date DESC;
    `;
    const values = [customerId];
    const result = await db.query(query, values);
    const orders = result.rows.map(order => {
      const orderDate = new Date(order.order_date);
            const [hours, minutes, seconds] = order.prep_time.split(':').map(Number);
      const prepTimeInMinutes = hours * 60 + minutes + seconds / 60 + 15; 
      const preparingUntil = new Date(orderDate.getTime() + prepTimeInMinutes * 60000);
      const currentStatus = new Date() < preparingUntil ? "preparing" : "delivered";
      return { ...order, order_status: currentStatus };
    });

    res.render('customer/orders', { customerName, orders });
  } catch (err) {
    console.error('Error fetching orders:', err);
    res.status(500).send('Error fetching orders.');
  }  
});


app.get('/get-branch-name/:ifsc', async (req, res) => {
  const IFSC = req.params.ifsc;

  try {
    const response = await axios.get(`https://ifsc.razorpay.com/${IFSC}`);
    
    if (response.data && response.data.BRANCH) {
      res.json({ branch: response.data.BRANCH });
    } else {
      console.error('Branch not found for IFSC:', IFSC);
      res.json({ branch: null });
    }
  } catch (error) {
    console.error('Error fetching IFSC details:', error.message);  
    res.json({ branch: null });
  }
});

app.post('/logout/seller', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      console.error('Error during seller logout:', err);
      return res.redirect('/seller/home');
    }
    res.redirect('/seller/login'); 
  });
});

app.post('/logout/customer', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      console.error('Error during customer logout:', err);
      return res.redirect('/customer/home');
    }
    res.redirect('/customer/login'); 
  });
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
}); 