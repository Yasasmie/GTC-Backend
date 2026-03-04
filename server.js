// backend/server.js
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' })); // allow base64 images

const DB_PATH = path.join(__dirname, 'db.json');

function readDb() {
  if (!fs.existsSync(DB_PATH)) {
    const initial = {
      users: [],
      accounts: [],
      bots: [],
      adminBots: [],
      careers: [],
      nextUserId: 1,
    };
    fs.writeFileSync(DB_PATH, JSON.stringify(initial, null, 2), 'utf8');
    return initial;
  }

  const raw = fs.readFileSync(DB_PATH, 'utf8');
  try {
    const parsed = JSON.parse(raw);
    // ensure new arrays exist if db was created earlier
    if (!parsed.accounts) parsed.accounts = [];
    if (!parsed.bots) parsed.bots = [];
    if (!parsed.adminBots) parsed.adminBots = [];
    if (!parsed.careers) parsed.careers = [];
    if (parsed.nextUserId == null) parsed.nextUserId = 1;
    return parsed;
  } catch (e) {
    console.error('Failed to parse db.json, reinitializing.', e);
    const initial = {
      users: [],
      accounts: [],
      bots: [],
      adminBots: [],
      careers: [],
      nextUserId: 1,
    };
    fs.writeFileSync(DB_PATH, JSON.stringify(initial, null, 2), 'utf8');
    return initial;
  }
}

function writeDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
}

// ---------------- USERS + KYC ----------------

app.post('/api/users', (req, res) => {
  const { uid, email, name } = req.body;

  if (!uid || !email) {
    return res.status(400).json({ message: 'uid and email are required' });
  }

  const db = readDb();

  const existing = db.users.find(u => u.uid === uid);
  if (existing) {
    return res.json(existing);
  }

  const newUser = {
    id: db.nextUserId++,
    uid,
    email,
    name: name || '',
    status: 'pending',
    kycCompleted: false,
    kycStatus: 'pending', // 'pending' | 'approved' | 'rejected'
    kyc: null,
  };

  db.users.push(newUser);
  writeDb(db);

  res.status(201).json(newUser);
});

app.get('/api/users/:uid', (req, res) => {
  const db = readDb();
  const user = db.users.find(u => u.uid === req.params.uid);
  if (!user) return res.status(404).json({ message: 'User not found' });
  res.json(user);
});

app.get('/api/users/:uid/profile', (req, res) => {
  const db = readDb();
  const user = db.users.find(u => u.uid === req.params.uid);
  if (!user) return res.status(404).json({ message: 'User not found' });

  res.json({
    uid: user.uid,
    email: user.email,
    name: user.name,
    status: user.status,
    kycCompleted: user.kycCompleted,
    kycStatus: user.kycStatus || 'pending',
    kyc: user.kyc,
  });
});

// User: submit KYC (with NIC front/back base64)
app.post('/api/users/:uid/kyc', (req, res) => {
  const db = readDb();
  const user = db.users.find(u => u.uid === req.params.uid);
  if (!user) return res.status(404).json({ message: 'User not found' });

  const {
    fullName,
    address,
    city,
    country,
    idNumber,
    nicFront,
    nicBack,
  } = req.body;

  user.kycCompleted = true;
  user.kycStatus = 'pending';
  user.kyc = {
    fullName,
    address,
    city,
    country,
    idNumber,
    nicFront: nicFront || null,
    nicBack: nicBack || null,
  };

  writeDb(db);

  res.json({ message: 'KYC submitted', user });
});

// Admin: list all users
app.get('/api/admin/users', (req, res) => {
  const db = readDb();
  res.json(db.users);
});

app.put('/api/admin/users/:id/approve', (req, res) => {
  const id = Number(req.params.id);
  const db = readDb();
  const user = db.users.find(u => u.id === id);
  if (!user) return res.status(404).json({ message: 'User not found' });

  user.status = 'approved';
  writeDb(db);

  res.json(user);
});

app.delete('/api/admin/users/:id', (req, res) => {
  const id = Number(req.params.id);
  const db = readDb();
  const index = db.users.findIndex(u => u.id === id);
  if (index === -1)
    return res.status(404).json({ message: 'User not found' });

  db.users.splice(index, 1);
  writeDb(db);

  res.json({ message: 'User deleted' });
});

// ---------------- KYC ADMIN ----------------

// list users who submitted KYC
app.get('/api/admin/kyc-requests', (req, res) => {
  const db = readDb();
  const withKyc = db.users.filter(u => u.kyc);
  res.json(
    withKyc.map(u => ({
      id: u.id,
      uid: u.uid,
      name: u.name,
      email: u.email,
      kycStatus: u.kycStatus || 'pending',
    }))
  );
});

// get full KYC details for a user (by id)
app.get('/api/admin/kyc-requests/:id', (req, res) => {
  const id = Number(req.params.id);
  const db = readDb();
  const user = db.users.find(u => u.id === id);
  if (!user || !user.kyc) {
    return res.status(404).json({ message: 'KYC not found' });
  }
  res.json({
    id: user.id,
    uid: user.uid,
    name: user.name,
    email: user.email,
    kycStatus: user.kycStatus,
    kyc: user.kyc,
  });
});

// approve KYC
app.put('/api/admin/kyc-requests/:id/approve', (req, res) => {
  const id = Number(req.params.id);
  const db = readDb();
  const user = db.users.find(u => u.id === id);
  if (!user || !user.kyc) {
    return res.status(404).json({ message: 'KYC not found' });
  }
  user.kycStatus = 'approved';
  writeDb(db);
  res.json({ message: 'KYC approved', user });
});

// reject KYC
app.put('/api/admin/kyc-requests/:id/reject', (req, res) => {
  const id = Number(req.params.id);
  const db = readDb();
  const user = db.users.find(u => u.id === id);
  if (!user || !user.kyc) {
    return res.status(404).json({ message: 'KYC not found' });
  }
  user.kycStatus = 'rejected';
  writeDb(db);
  res.json({ message: 'KYC rejected', user });
});

// ---------------- ACCOUNTS ----------------

// Create account for a user
app.post('/api/users/:uid/accounts', (req, res) => {
  const { uid } = req.params;
  const { broker, accountType, accountNumber } = req.body;

  if (!broker || !accountType || !accountNumber) {
    return res.status(400).json({
      message: 'broker, accountType and accountNumber are required',
    });
  }

  const db = readDb();

  // ensure user exists
  const user = db.users.find(u => u.uid === uid);
  if (!user) {
    return res.status(404).json({ message: 'User not found' });
  }

  const newAccount = {
    id: Date.now(),
    uid,
    broker,
    accountType,
    accountNumber,
  };

  db.accounts.push(newAccount);
  writeDb(db);

  res.status(201).json(newAccount);
});

// Get all accounts for a user
app.get('/api/users/:uid/accounts', (req, res) => {
  const { uid } = req.params;
  const db = readDb();
  const userAccounts = db.accounts.filter(a => a.uid === uid);
  res.json(userAccounts);
});

// Delete one account
app.delete('/api/users/:uid/accounts/:id', (req, res) => {
  const { uid, id } = req.params;
  const numericId = Number(id);

  const db = readDb();
  const index = db.accounts.findIndex(
    a => a.uid === uid && a.id === numericId
  );
  if (index === -1) {
    return res.status(404).json({ message: 'Account not found' });
  }

  db.accounts.splice(index, 1);
  writeDb(db);

  res.json({ message: 'Account deleted' });
});

// ---------------- BOTS ----------------

function ensureBotsArray(db) {
  if (!db.bots) db.bots = [];
}

// OLD static catalog
const BOT_CATALOG = [
  { id: 'bot1', name: 'Scalper Pro', price: 49.99 },
  { id: 'bot2', name: 'Trend Rider', price: 59.99 },
  { id: 'bot3', name: 'Grid Master', price: 39.99 },
];

app.get('/api/bots/catalog', (req, res) => {
  res.json(BOT_CATALOG);
});

// Create a bot assignment for a user, using adminBots as source of truth
app.post('/api/users/:uid/bots', (req, res) => {
  const { uid } = req.params;
  const { brokerAccountId, botId, signedAgreementUrl } = req.body;

  if (!brokerAccountId || !botId || !signedAgreementUrl) {
    return res.status(400).json({
      message: 'brokerAccountId, botId and signedAgreementUrl are required',
    });
  }

  const db = readDb();

  const user = db.users.find(u => u.uid === uid);
  if (!user) return res.status(404).json({ message: 'User not found' });

  const account = db.accounts.find(
    a => a.id === brokerAccountId && a.uid === uid
  );
  if (!account) {
    return res.status(404).json({ message: 'Broker account not found' });
  }

  if (!db.adminBots) db.adminBots = [];
  const adminBot = db.adminBots.find(b => b.id === botId);
  if (!adminBot) {
    return res.status(404).json({ message: 'Bot not found' });
  }

  ensureBotsArray(db);

  const newUserBot = {
    id: Date.now(),
    uid,
    brokerAccountId,
    botId,
    signedAgreementUrl,
    botName: adminBot.name,
    price: adminBot.price,
    broker: account.broker,
    accountNumber: account.accountNumber,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };

  db.bots.push(newUserBot);
  writeDb(db);

  res.status(201).json(newUserBot);
});

// Get all bots for a user
app.get('/api/users/:uid/bots', (req, res) => {
  const { uid } = req.params;
  const db = readDb();
  ensureBotsArray(db);
  const userBots = db.bots.filter(b => b.uid === uid);
  res.json(userBots);
});

// ---------------- ADMIN MANAGE BOTS ----------------

function ensureAdminBotsArray(db) {
  if (!db.adminBots) db.adminBots = [];
}

// List all bots, newest first
app.get('/api/admin/bots', (req, res) => {
  const db = readDb();
  ensureAdminBotsArray(db);
  const sorted = [...db.adminBots].sort((a, b) => b.id - a.id);
  res.json(sorted);
});

// Create new bot
app.post('/api/admin/bots', (req, res) => {
  const { name, price, cost, subscriptionFee } = req.body;
  if (!name || price == null || cost == null || subscriptionFee == null) {
    return res
      .status(400)
      .json({ message: 'name, price, cost, subscriptionFee are required' });
  }

  const db = readDb();
  ensureAdminBotsArray(db);

  const newBot = {
    id: Date.now(),
    name,
    price,
    cost,
    subscriptionFee,
    createdAt: new Date().toISOString(),
  };

  db.adminBots.push(newBot);
  writeDb(db);

  res.status(201).json(newBot);
});

// Update bot
app.put('/api/admin/bots/:id', (req, res) => {
  const id = Number(req.params.id);
  const { name, price, cost, subscriptionFee } = req.body;

  const db = readDb();
  ensureAdminBotsArray(db);

  const bot = db.adminBots.find(b => b.id === id);
  if (!bot) return res.status(404).json({ message: 'Bot not found' });

  bot.name = name ?? bot.name;
  bot.price = price ?? bot.price;
  bot.cost = cost ?? bot.cost;
  bot.subscriptionFee = subscriptionFee ?? bot.subscriptionFee;

  writeDb(db);

  res.json(bot);
});

// Delete bot
app.delete('/api/admin/bots/:id', (req, res) => {
  const id = Number(req.params.id);
  const db = readDb();
  ensureAdminBotsArray(db);

  const index = db.adminBots.findIndex(b => b.id === id);
  if (index === -1) {
    return res.status(404).json({ message: 'Bot not found' });
  }

  db.adminBots.splice(index, 1);
  writeDb(db);

  res.json({ message: 'Bot deleted' });
});

// ---------------- ADMIN BOT REQUESTS ----------------

// List all bot requests
app.get('/api/admin/bot-requests', (req, res) => {
  const db = readDb();
  ensureBotsArray(db);

  const requests = db.bots
    .map(b => {
      const user = db.users.find(u => u.uid === b.uid);
      return {
        id: b.id,
        uid: b.uid,
        userName: user ? user.name : 'Unknown',
        userEmail: user ? user.email : '',
        broker: b.broker,
        accountNumber: b.accountNumber,
        botName: b.botName,
        price: b.price,
        signedAgreementUrl: b.signedAgreementUrl,
        status: b.status || 'pending',
        createdAt: b.createdAt,
      };
    })
    .sort((a, b) => b.id - a.id);

  res.json(requests);
});

// Get single bot request
app.get('/api/admin/bot-requests/:id', (req, res) => {
  const id = Number(req.params.id);
  const db = readDb();
  ensureBotsArray(db);

  const b = db.bots.find(x => x.id === id);
  if (!b) return res.status(404).json({ message: 'Bot request not found' });

  const user = db.users.find(u => u.uid === b.uid);
  res.json({
    id: b.id,
    uid: b.uid,
    userName: user ? user.name : 'Unknown',
    userEmail: user ? user.email : '',
    broker: b.broker,
    accountNumber: b.accountNumber,
    botName: b.botName,
    price: b.price,
    signedAgreementUrl: b.signedAgreementUrl,
    status: b.status || 'pending',
    createdAt: b.createdAt,
  });
});

// Approve bot request
app.put('/api/admin/bot-requests/:id/approve', (req, res) => {
  const id = Number(req.params.id);
  const db = readDb();
  ensureBotsArray(db);

  const b = db.bots.find(x => x.id === id);
  if (!b) return res.status(404).json({ message: 'Bot request not found' });

  b.status = 'approved';
  writeDb(db);
  res.json({ message: 'Bot request approved', bot: b });
});

// Reject bot request
app.put('/api/admin/bot-requests/:id/reject', (req, res) => {
  const id = Number(req.params.id);
  const db = readDb();
  ensureBotsArray(db);

  const b = db.bots.find(x => x.id === id);
  if (!b) return res.status(404).json({ message: 'Bot request not found' });

  b.status = 'rejected';
  writeDb(db);
  res.json({ message: 'Bot request rejected', bot: b });
});

// ---------------- CAREERS ----------------

// User: submit career application
app.post('/api/careers', (req, res) => {
  const {
    name,
    address,
    nic,
    phone,
    whatsapp,
    email,
    currentlyWorking,
    employmentType,
    yearsExperience,
    preferredRole,
    availableFrom,
    notes,
  } = req.body;

  if (!name || !address || !nic || !phone || !whatsapp) {
    return res.status(400).json({ message: 'Required fields missing' });
  }

  const db = readDb();
  if (!db.careers) db.careers = [];

  const newApplication = {
    id: Date.now(),
    name,
    address,
    nic,
    phone,
    whatsapp,
    email: email || '',
    currentlyWorking: currentlyWorking || 'no',
    employmentType: employmentType || 'full-time',
    yearsExperience: yearsExperience || '',
    preferredRole: preferredRole || '',
    availableFrom: availableFrom || '',
    notes: notes || '',
    createdAt: new Date().toISOString(),
  };

  db.careers.push(newApplication);
  writeDb(db);

  res.status(201).json(newApplication);
});

// Admin: list all career applications
app.get('/api/admin/careers', (req, res) => {
  const db = readDb();
  if (!db.careers) db.careers = [];
  const sorted = [...db.careers].sort((a, b) => b.id - a.id);
  res.json(sorted);
});

// ---------------- COURSES (ENHANCED) ----------------

function ensureCoursesArray(db) {
  if (!db.courses) db.courses = [];
}

function ensureCourseApplicationsArray(db) {
  if (!db.courseApplications) db.courseApplications = [];
}

// Public: Get all courses
app.get('/api/courses', (req, res) => {
  try {
    const db = readDb();
    ensureCoursesArray(db);
    const sortedCourses = [...db.courses].sort(
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
    );
    res.json(sortedCourses);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch courses' });
  }
});

// Admin: Create course
app.post('/api/admin/courses', (req, res) => {
  try {
    const db = readDb();
    ensureCoursesArray(db);

    const body = req.body || {};
    // normalize youtubeLinks to array
    let youtubeLinks = body.youtubeLinks;
    if (!Array.isArray(youtubeLinks)) {
      if (body.youtubeLink && typeof body.youtubeLink === 'string') {
        youtubeLinks = [body.youtubeLink];
      } else {
        youtubeLinks = [];
      }
    }

    const newCourse = {
      id: Date.now(),
      title: body.title || '',
      description: body.description || '',
      duration: body.duration || '',
      category: body.category || 'Management',
      type: body.type || 'online',              // 'online' or 'physical'
      level: body.level || 'Beginner',
      thumbnail: body.thumbnail || '',
      youtubeLinks,
      location: body.location || '',
      date: body.date || '',
      price: body.price != null ? body.price : 0,
      createdAt: new Date().toISOString(),
    };

    db.courses.push(newCourse);
    writeDb(db);
    res.status(201).json(newCourse);
  } catch (err) {
    res.status(400).json({ error: 'Failed to create course' });
  }
});

// Admin: Update course
app.put('/api/admin/courses/:id', (req, res) => {
  try {
    const db = readDb();
    ensureCoursesArray(db);
    const id = Number(req.params.id);
    const course = db.courses.find(c => c.id === id);
    if (!course) {
      return res.status(404).json({ error: 'Course not found' });
    }

    const body = req.body || {};

    if (body.title !== undefined) course.title = body.title;
    if (body.description !== undefined) course.description = body.description;
    if (body.duration !== undefined) course.duration = body.duration;
    if (body.category !== undefined) course.category = body.category;
    if (body.type !== undefined) course.type = body.type;
    if (body.level !== undefined) course.level = body.level;
    if (body.thumbnail !== undefined) course.thumbnail = body.thumbnail;
    if (body.location !== undefined) course.location = body.location;
    if (body.date !== undefined) course.date = body.date;
    if (body.price !== undefined) course.price = body.price;

    // youtubeLinks: always store array of strings
    if (body.youtubeLinks !== undefined) {
      if (Array.isArray(body.youtubeLinks)) {
        course.youtubeLinks = body.youtubeLinks;
      } else if (body.youtubeLink && typeof body.youtubeLink === 'string') {
        course.youtubeLinks = [body.youtubeLink];
      }
    }

    writeDb(db);
    res.json(course);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update course' });
  }
});

// Admin: Delete course
app.delete('/api/admin/courses/:id', (req, res) => {
  try {
    const db = readDb();
    ensureCoursesArray(db);
    const id = Number(req.params.id);
    const index = db.courses.findIndex(c => c.id === id);
    if (index === -1) return res.status(404).json({ error: 'Course not found' });

    db.courses.splice(index, 1);
    writeDb(db);
    res.json({ message: 'Course deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Delete failed' });
  }
});

// ---------------- COURSE APPLICATIONS ----------------

// User: submit course application with payment slip (base64 or URL)
app.post('/api/courses/apply', (req, res) => {
  try {
    const {
      courseId,
      name,
      email,
      phone,
      notes,
      paymentSlip, // string: base64 image or URL
    } = req.body;

    if (!courseId || !name || !email || !paymentSlip) {
      return res.status(400).json({ error: 'courseId, name, email, paymentSlip are required' });
    }

    const db = readDb();
    ensureCoursesArray(db);
    ensureCourseApplicationsArray(db);

    const course = db.courses.find(c => c.id === Number(courseId));
    if (!course) {
      return res.status(404).json({ error: 'Course not found' });
    }

    const appRecord = {
      id: Date.now(),
      courseId: course.id,
      courseTitle: course.title,
      category: course.category,
      type: course.type,
      price: course.price,
      name,
      email,
      phone: phone || '',
      notes: notes || '',
      paymentSlip, // store raw string
      status: 'pending',
      createdAt: new Date().toISOString(),
    };

    db.courseApplications.push(appRecord);
    writeDb(db);

    res.status(201).json(appRecord);
  } catch (err) {
    res.status(500).json({ error: 'Failed to submit course application' });
  }
});

// Admin: list all course applications
app.get('/api/admin/course-applications', (req, res) => {
  try {
    const db = readDb();
    ensureCourseApplicationsArray(db);
    const sorted = [...db.courseApplications].sort((a, b) => b.id - a.id);
    res.json(sorted);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch course applications' });
  }
});

// Admin: update application status
app.put('/api/admin/course-applications/:id/status', (req, res) => {
  try {
    const id = Number(req.params.id);
    const { status } = req.body; // 'pending' | 'approved' | 'rejected'
    const db = readDb();
    ensureCourseApplicationsArray(db);

    const appRecord = db.courseApplications.find(a => a.id === id);
    if (!appRecord) {
      return res.status(404).json({ error: 'Application not found' });
    }

    if (status) appRecord.status = status;

    writeDb(db);
    res.json(appRecord);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update application status' });
  }
});


// ---------------- SERVER ----------------

const PORT = 5000;
app.listen(PORT, () => {
  console.log(`Backend API running on port ${PORT}`);
});
