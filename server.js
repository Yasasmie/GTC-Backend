// backend/server.js
const express = require('express');
const cors = require('cors');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' })); // allow base64 images

function createInitialDb() {
  return {
    users: [],
    accounts: [],
    bots: [],
    adminBots: [],
    careers: [],
    resaleRequests: [],
    resaleHistory: [],
    paymentRecords: [],
    adminCommissionSubmissions: [],
    courses: [],
    courseApplications: [],
    notifications: [],
    nextUserId: 1,
  };
}

function applyDbDefaults(db = {}) {
  const initial = createInitialDb();
  const normalized = { ...initial, ...db };

  if (!Array.isArray(normalized.users)) normalized.users = [];
  if (!Array.isArray(normalized.accounts)) normalized.accounts = [];
  if (!Array.isArray(normalized.bots)) normalized.bots = [];
  if (!Array.isArray(normalized.adminBots)) normalized.adminBots = [];
  if (!Array.isArray(normalized.careers)) normalized.careers = [];
  if (!Array.isArray(normalized.resaleRequests)) normalized.resaleRequests = [];
  if (!Array.isArray(normalized.resaleHistory)) normalized.resaleHistory = [];
  if (!Array.isArray(normalized.paymentRecords)) normalized.paymentRecords = [];
  if (!Array.isArray(normalized.adminCommissionSubmissions)) normalized.adminCommissionSubmissions = [];
  if (!Array.isArray(normalized.courses)) normalized.courses = [];
  if (!Array.isArray(normalized.courseApplications)) normalized.courseApplications = [];
  if (!Array.isArray(normalized.notifications)) normalized.notifications = [];
  if (typeof normalized.nextUserId !== 'number' || normalized.nextUserId < 1) {
    normalized.nextUserId = 1;
  }

  return normalized;
}

function normalizePrivateKey(rawKey) {
  if (!rawKey || typeof rawKey !== 'string') return '';
  const trimmed = rawKey.trim();
  const unwrapped =
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
      ? trimmed.slice(1, -1)
      : trimmed;
  return unwrapped.replace(/\\n/g, '\n');
}

function buildCredentialFromServiceAccount(serviceAccount) {
  if (!serviceAccount?.project_id || !serviceAccount?.client_email || !serviceAccount?.private_key) {
    return null;
  }

  return {
    credential: cert({
      projectId: serviceAccount.project_id,
      clientEmail: serviceAccount.client_email,
      privateKey: normalizePrivateKey(serviceAccount.private_key),
    }),
  };
}

function getFirebaseCredentialConfig() {
  const serviceAccountJsonRaw =
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
    process.env.FIREBASE_SERVICE_ACCOUNT ||
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

  // Render-friendly option: full service account JSON in a single env var
  if (serviceAccountJsonRaw) {
    try {
      const parsed = JSON.parse(serviceAccountJsonRaw);
      const fromJson = buildCredentialFromServiceAccount(parsed);
      if (fromJson) return fromJson;
    } catch (error) {
      console.error('Service account JSON env is not valid JSON:', error.message);
    }
  }

  // Alternate option: base64-encoded service account JSON
  const serviceAccountBase64Raw =
    process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 ||
    process.env.FIREBASE_SERVICE_ACCOUNT_B64 ||
    process.env.GOOGLE_SERVICE_ACCOUNT_BASE64;

  if (serviceAccountBase64Raw) {
    try {
      const json = Buffer.from(serviceAccountBase64Raw, 'base64').toString('utf8');
      const parsed = JSON.parse(json);
      const fromBase64 = buildCredentialFromServiceAccount(parsed);
      if (fromBase64) return fromBase64;
    } catch (error) {
      console.error('Service account base64 env is invalid:', error.message);
    }
  }

  // Split env vars option
  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.FIREBASE_PROJECTID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = normalizePrivateKey(process.env.FIREBASE_PRIVATE_KEY);

  if (projectId && clientEmail && privateKey) {
    return {
      credential: cert({
        projectId,
        clientEmail,
        privateKey,
      }),
    };
  }

  return null;
}

function initializeFirebaseAdmin() {
  if (getApps().length > 0) {
    return getApps()[0];
  }

  const credentialConfig = getFirebaseCredentialConfig();
  if (credentialConfig) {
    return initializeApp(credentialConfig);
  }

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return initializeApp();
  }

  throw new Error(
    'Missing Firebase credentials. Set FIREBASE_SERVICE_ACCOUNT_JSON, FIREBASE_SERVICE_ACCOUNT_BASE64, GOOGLE_APPLICATION_CREDENTIALS, or FIREBASE_PROJECT_ID/FIREBASE_CLIENT_EMAIL/FIREBASE_PRIVATE_KEY.'
  );
}

const firebaseApp = initializeFirebaseAdmin();
const firestore = getFirestore(firebaseApp);
const FIRESTORE_COLLECTION = process.env.FIRESTORE_COLLECTION || 'gtc';
const FIRESTORE_DOC = process.env.FIRESTORE_DOC || 'appData';
const dbRef = firestore.collection(FIRESTORE_COLLECTION).doc(FIRESTORE_DOC);
const adminBotsRef = firestore
  .collection(FIRESTORE_COLLECTION)
  .doc(`${FIRESTORE_DOC}_adminBots`);

let dbCache = createInitialDb();
let persistQueue = Promise.resolve();

function readDb() {
  return JSON.parse(JSON.stringify(dbCache));
}

function clearInlineBlob(value) {
  if (typeof value !== 'string') return value;
  return value.startsWith('data:') ? null : value;
}

function compactDbForPersistence(db) {
  const normalized = applyDbDefaults(db);

  normalized.users = normalized.users.map(user => {
    if (!user || typeof user !== 'object' || !user.kyc) return user;
    const status = String(user.kycStatus || '').toLowerCase();
    if (!['approved', 'rejected'].includes(status)) return user;

    return {
      ...user,
      kyc: {
        ...user.kyc,
        nicFront: clearInlineBlob(user.kyc.nicFront),
        nicBack: clearInlineBlob(user.kyc.nicBack),
      },
    };
  });

  normalized.bots = normalized.bots.map(bot => {
    if (!bot || typeof bot !== 'object') return bot;
    const status = String(bot.status || '').toLowerCase();
    if (!['approved', 'rejected'].includes(status)) return bot;

    return {
      ...bot,
      paymentSlip: clearInlineBlob(bot.paymentSlip),
      signedAgreementUrl: clearInlineBlob(bot.signedAgreementUrl),
    };
  });

  normalized.resaleRequests = normalized.resaleRequests.map(request => {
    if (!request || typeof request !== 'object') return request;
    const status = String(request.status || '').toLowerCase();
    if (!['approved', 'rejected'].includes(status)) return request;

    return {
      ...request,
      paymentSlip: clearInlineBlob(request.paymentSlip),
      adminPaymentSlip: clearInlineBlob(request.adminPaymentSlip),
    };
  });

  normalized.adminCommissionSubmissions = normalized.adminCommissionSubmissions.map(submission => {
    if (!submission || typeof submission !== 'object') return submission;
    const status = String(submission.status || '').toLowerCase();
    if (status === 'pending') return submission;

    return {
      ...submission,
      adminPaymentSlip: clearInlineBlob(submission.adminPaymentSlip),
      paymentSlip: clearInlineBlob(submission.paymentSlip),
    };
  });

  return normalized;
}

function writeDb(db) {
  const normalized = applyDbDefaults(db);
  dbCache = normalized;

  // Recover queue after transient Firestore failures instead of leaving it permanently rejected.
  persistQueue = persistQueue
    .catch(error => {
      console.error('Recovering from previous persistence error:', error);
    })
    .then(async () => {
      const payload = compactDbForPersistence(normalized);
      await dbRef.set(payload);
      dbCache = payload;
    });
}

async function writeDbAndWait(db) {
  writeDb(db);
  await persistQueue;
}

async function loadDbFromFirestore() {
  const snapshot = await dbRef.get();
  if (!snapshot.exists) {
    dbCache = createInitialDb();
    await dbRef.set(dbCache);
    return;
  }

  dbCache = applyDbDefaults(snapshot.data());
}

function sanitizeAdminBots(rawBots) {
  if (!Array.isArray(rawBots)) return [];
  return rawBots.filter(bot => bot && typeof bot === 'object');
}

async function getAdminBotsStore() {
  const snapshot = await adminBotsRef.get();
  if (snapshot.exists) {
    const data = snapshot.data() || {};
    return sanitizeAdminBots(data.bots);
  }

  // One-time fallback from legacy appData storage.
  const db = readDb();
  ensureAdminBotsArray(db);
  const legacyBots = sanitizeAdminBots(db.adminBots);
  await adminBotsRef.set({ bots: legacyBots }, { merge: true });
  return legacyBots;
}

async function saveAdminBotsStore(bots) {
  await adminBotsRef.set({ bots: sanitizeAdminBots(bots) }, { merge: true });
}

function ensurePaymentArrays(db) {
  if (!db.paymentRecords) db.paymentRecords = [];
  if (!db.adminCommissionSubmissions) db.adminCommissionSubmissions = [];
}

function getMonthKey(dateValue) {
  const date = new Date(dateValue);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

function buildMonthlyMap(items, getAmount, getDate) {
  const map = {};
  items.forEach(item => {
    const key = getMonthKey(getDate(item));
    map[key] = (map[key] || 0) + (Number(getAmount(item)) || 0);
  });
  return map;
}

function toMonthlyHistory(keys, getLabel, valuesByKey) {
  return keys.map(key => ({
    month: key,
    label: getLabel(key),
    value: Number(valuesByKey[key] || 0),
  }));
}

function monthLabel(monthKey) {
  const [year, month] = monthKey.split('-').map(Number);
  return new Date(year, month - 1, 1).toLocaleString('en-US', {
    month: 'long',
    year: 'numeric',
  });
}

function sortNewest(items = [], dateKey = 'createdAt') {
  return [...items].sort((a, b) => {
    const aDate = new Date(a?.[dateKey] || 0).getTime();
    const bDate = new Date(b?.[dateKey] || 0).getTime();
    if (Number.isFinite(aDate) && Number.isFinite(bDate) && aDate !== bDate) {
      return bDate - aDate;
    }
    const aId = Number(a?.id || 0);
    const bId = Number(b?.id || 0);
    return bId - aId;
  });
}

function calculateResellerEarning(adminBasePrice, resalePrice) {
  const base = Number(adminBasePrice || 0);
  const resale = Number(resalePrice || 0);
  const addedAmount = Math.max(resale - base, 0);
  return Number((base * 0.35 + addedAmount).toFixed(2));
}

function calculateAdminPayablePrice(actualBotPrice) {
  return Number((Number(actualBotPrice || 0) * 0.65).toFixed(2));
}

function serializeUserSummary(user) {
  return {
    id: user.id,
    uid: user.uid,
    email: user.email,
    name: user.name,
    status: user.status,
    kycCompleted: user.kycCompleted,
    kycStatus: user.kycStatus || 'pending',
    totalSells: user.totalSells || 0,
    totalRevenue: user.totalRevenue || 0,
    referredBy: user.referredBy || null,
    hasKyc: !!user.kyc,
  };
}

// ---------------- USERS + KYC ----------------

app.post('/api/users', async (req, res) => {
  const { uid, email, name, referredBy } = req.body;

  if (!uid || !email) {
    return res.status(400).json({ message: 'uid and email are required' });
  }

  const db = readDb();

  const existing = db.users.find(u => u.uid === uid);
  if (existing) {
    return res.json(existing);
  }

  let normalizedReferredBy = null;
  if (typeof referredBy === 'string' && referredBy.trim()) {
    const referralCode = referredBy.trim().replace(/\/+$/, '');
    const referralOwner = db.users.find(
      u => u.uid === referralCode || String(u.id) === referralCode
    );

    if (!referralOwner) {
      return res.status(400).json({ message: 'Invalid referral code' });
    }

    normalizedReferredBy = referralOwner.uid;
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
    totalSells: 0,
    totalRevenue: 0,
    referredBy: normalizedReferredBy,
  };

  db.users.push(newUser);
  await writeDbAndWait(db);

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
    totalSells: user.totalSells || 0,
    totalRevenue: user.totalRevenue || 0,
    referredBy: user.referredBy || null,
  });
});

// User: submit KYC (with NIC front/back base64)
app.post('/api/users/:uid/kyc', async (req, res) => {
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

  await writeDbAndWait(db);

  res.json({ message: 'KYC submitted', user });
});

// Admin: list all users
app.get('/api/admin/users', (req, res) => {
  const db = readDb();
  res.json(sortNewest(db.users, 'id'));
});

app.get('/api/admin/users/:uid/network', (req, res) => {
  const { uid } = req.params;
  const db = readDb();

  const user = db.users.find(u => u.uid === uid);
  if (!user) {
    return res.status(404).json({ message: 'User not found' });
  }

  const directReferrals = db.users
    .filter(u => u.referredBy === uid)
    .sort((a, b) => b.id - a.id)
    .map(serializeUserSummary);

  res.json({
    user: serializeUserSummary(user),
    referralCount: directReferrals.length,
    directReferrals,
  });
});

app.put('/api/admin/users/:id/approve', async (req, res) => {
  const id = Number(req.params.id);
  const db = readDb();
  const user = db.users.find(u => u.id === id);
  if (!user) return res.status(404).json({ message: 'User not found' });

  user.status = 'approved';
  await writeDbAndWait(db);

  res.json(user);
});

app.delete('/api/admin/users/:id', async (req, res) => {
  const id = Number(req.params.id);
  const db = readDb();
  const index = db.users.findIndex(u => u.id === id);
  if (index === -1)
    return res.status(404).json({ message: 'User not found' });

  db.users.splice(index, 1);
  await writeDbAndWait(db);

  res.json({ message: 'User deleted' });
});

// ---------------- KYC ADMIN ----------------

// list users who submitted KYC
app.get('/api/admin/kyc-requests', (req, res) => {
  const db = readDb();
  const withKyc = sortNewest(db.users.filter(u => u.kyc), 'id');
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
app.put('/api/admin/kyc-requests/:id/approve', async (req, res) => {
  const id = Number(req.params.id);
  const db = readDb();
  const user = db.users.find(u => u.id === id);
  if (!user || !user.kyc) {
    return res.status(404).json({ message: 'KYC not found' });
  }
  user.kycStatus = 'approved';
  await writeDbAndWait(db);
  res.json({ message: 'KYC approved', user });
});

// reject KYC
app.put('/api/admin/kyc-requests/:id/reject', async (req, res) => {
  const id = Number(req.params.id);
  const db = readDb();
  const user = db.users.find(u => u.id === id);
  if (!user || !user.kyc) {
    return res.status(404).json({ message: 'KYC not found' });
  }
  user.kycStatus = 'rejected';
  await writeDbAndWait(db);
  res.json({ message: 'KYC rejected', user });
});

// ---------------- ACCOUNTS ----------------

// Create account for a user
app.post('/api/users/:uid/accounts', async (req, res) => {
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
  await writeDbAndWait(db);

  res.status(201).json(newAccount);
});

// Get all accounts for a user
app.get('/api/users/:uid/accounts', (req, res) => {
  const { uid } = req.params;
  const db = readDb();
  const userAccounts = sortNewest(
    db.accounts.filter(a => a.uid === uid),
    'id'
  );
  res.json(userAccounts);
});

// Delete one account
app.delete('/api/users/:uid/accounts/:id', async (req, res) => {
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
  await writeDbAndWait(db);

  res.json({ message: 'Account deleted' });
});

// ---------------- BOTS ----------------

function ensureBotsArray(db) {
  if (!Array.isArray(db.bots)) db.bots = [];
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
app.post('/api/users/:uid/bots', async (req, res) => {
  try {
    const { uid } = req.params;
    const { brokerAccountId, botId, signedAgreementUrl, paymentSlip, requestType } = req.body;
    const normalizedRequestType =
      requestType === 'resell_request' ? 'resell_request' : 'direct_buy';

    if (!botId) {
      return res.status(400).json({
        message: 'botId is required',
      });
    }

    const db = readDb();

    const user = db.users.find(u => u.uid === uid);
    if (!user) return res.status(404).json({ message: 'User not found' });

    let account = null;
    if (normalizedRequestType === 'direct_buy') {
      if (!brokerAccountId || !signedAgreementUrl || !paymentSlip) {
        return res.status(400).json({
          message: 'Direct buy requires brokerAccountId, signedAgreementUrl and paymentSlip',
        });
      }

      account = db.accounts.find(
        a => a.id === brokerAccountId && a.uid === uid
      );
      if (!account) {
        return res.status(404).json({ message: 'Broker account not found' });
      }
    }

    const adminBots = await getAdminBotsStore();
    const adminBot = adminBots.find(b => b.id === botId);
    if (!adminBot) {
      return res.status(404).json({ message: 'Bot not found' });
    }

    ensureBotsArray(db);

    const newUserBot = {
      id: Date.now(),
      uid,
      brokerAccountId: account ? brokerAccountId : null,
      botId,
      signedAgreementUrl: normalizedRequestType === 'direct_buy' ? signedAgreementUrl : null,
      paymentSlip: normalizedRequestType === 'direct_buy' ? paymentSlip : null,
      botName: adminBot.name,
      botType: adminBot.botType || 'Trading Bot',
      botModel: adminBot.botModel || 'N/A',
      price: adminBot.price,
      adminBasePrice: adminBot.price,
      broker: account ? account.broker : 'N/A',
      accountNumber: account ? account.accountNumber : 'N/A',
      accountType: account ? account.accountType || 'N/A' : 'N/A',
      requestType: normalizedRequestType,
      canResell: normalizedRequestType === 'resell_request',
      status: 'pending',
      createdAt: new Date().toISOString(),
    };

    db.bots.push(newUserBot);
    await writeDbAndWait(db);

    res.status(201).json(newUserBot);
  } catch (error) {
    console.error('Failed to create user bot request:', error);
    res.status(500).json({ message: error.message || 'Failed to create bot request' });
  }
});

// Get all bots for a user (user-facing)
app.get('/api/users/:uid/bots', (req, res) => {
  const { uid } = req.params;
  const db = readDb();
  ensureBotsArray(db);
  const userBots = sortNewest(
    db.bots.filter(b => b.uid === uid),
    'createdAt'
  );
  res.json(userBots);
});

// ADMIN: get all bots for a user by UID
app.get('/api/admin/users/:uid/bots', (req, res) => {
  const { uid } = req.params;
  const db = readDb();
  ensureBotsArray(db);

  const user = db.users.find(u => u.uid === uid);
  if (!user) {
    return res.status(404).json({ message: 'User not found' });
  }

  const userBots = sortNewest(
    db.bots.filter(b => b.uid === uid),
    'createdAt'
  );
  res.json(userBots);
});


// ---------------- ADMIN MANAGE BOTS ----------------

function ensureAdminBotsArray(db) {
  if (!Array.isArray(db.adminBots)) db.adminBots = [];
}

// List all bots, newest first
app.get('/api/admin/bots', async (req, res) => {
  try {
    const safeBots = await getAdminBotsStore();
    const sorted = [...safeBots].sort(
      (a, b) => Number(b.id || 0) - Number(a.id || 0)
    );
    res.json(sorted);
  } catch (error) {
    console.error('Failed to list admin bots:', error);
    res.status(500).json({ message: error.message || 'Failed to load bots' });
  }
});

// Create new bot
app.post('/api/admin/bots', async (req, res) => {
  try {
    const { name, price, cost, subscriptionFee, botType, botModel } = req.body || {};
    if (!name || price == null || cost == null || subscriptionFee == null) {
      return res
        .status(400)
        .json({ message: 'name, price, cost, subscriptionFee, botType, botModel are required' });
    }

    const numericPrice = Number(price);
    const numericCost = Number(cost);
    const numericSubscriptionFee = Number(subscriptionFee);
    if (
      !Number.isFinite(numericPrice) ||
      !Number.isFinite(numericCost) ||
      !Number.isFinite(numericSubscriptionFee)
    ) {
      return res.status(400).json({ message: 'price, cost and subscriptionFee must be valid numbers' });
    }

    const adminBots = await getAdminBotsStore();

    const newBot = {
      id: Date.now(),
      name: String(name).trim(),
      price: numericPrice,
      cost: numericCost,
      subscriptionFee: numericSubscriptionFee,
      botType: botType || 'Trading Bot',
      botModel: botModel || 'N/A',
      createdAt: new Date().toISOString(),
    };

    adminBots.push(newBot);
    await saveAdminBotsStore(adminBots);

    res.status(201).json(newBot);
  } catch (error) {
    console.error('Failed to create admin bot:', error);
    res.status(500).json({ message: error.message || 'Failed to create bot' });
  }
});

// Update bot
app.put('/api/admin/bots/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { name, price, cost, subscriptionFee } = req.body;

    const adminBots = await getAdminBotsStore();
    const bot = adminBots.find(b => b.id === id);
    if (!bot) return res.status(404).json({ message: 'Bot not found' });

    bot.name = name ?? bot.name;
    bot.price = price ?? bot.price;
    bot.cost = cost ?? bot.cost;
    bot.subscriptionFee = subscriptionFee ?? bot.subscriptionFee;

    await saveAdminBotsStore(adminBots);

    res.json(bot);
  } catch (error) {
    console.error('Failed to update admin bot:', error);
    res.status(500).json({ message: error.message || 'Failed to update bot' });
  }
});

// Delete bot
app.delete('/api/admin/bots/:id', async (req, res) => {
  const id = Number(req.params.id);
  const adminBots = await getAdminBotsStore();

  const index = adminBots.findIndex(b => b.id === id);
  if (index === -1) {
    return res.status(404).json({ message: 'Bot not found' });
  }

  adminBots.splice(index, 1);
  await saveAdminBotsStore(adminBots);

  res.json({ message: 'Bot deleted' });
});

// ---------------- ADMIN BOT REQUESTS ----------------

// List all bot requests
app.get('/api/admin/bot-requests', (req, res) => {
  const { type } = req.query;
  const db = readDb();
  ensureBotsArray(db);

  const requests = db.bots
    .filter(b => {
      const normalized = b.requestType || 'direct_buy';
      if (type === 'buying') return normalized === 'direct_buy';
      if (type === 'resell') return normalized === 'resell_request';
      return true;
    })
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
        paymentSlip: b.paymentSlip || null,
        signedAgreementUrl: b.signedAgreementUrl,
        requestType: b.requestType || 'direct_buy',
        canResell: !!b.canResell,
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
    paymentSlip: b.paymentSlip || null,
    signedAgreementUrl: b.signedAgreementUrl,
    requestType: b.requestType || 'direct_buy',
    canResell: !!b.canResell,
    status: b.status || 'pending',
    createdAt: b.createdAt,
  });
});

// Approve bot request
app.put('/api/admin/bot-requests/:id/approve', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const db = readDb();
    ensureBotsArray(db);
    ensurePaymentArrays(db);
    ensureNotificationsArray(db);

    const b = db.bots.find(x => x.id === id);
    if (!b) return res.status(404).json({ message: 'Bot request not found' });

    b.status = 'approved';
    const user = db.users.find(u => u.uid === b.uid);

    db.paymentRecords.push({
      id: Date.now(),
      uid: b.uid,
      userName: user ? user.name : 'Unknown',
      botId: b.id,
      botName: b.botName,
      amount: Number(b.price) || 0,
      category:
        (b.requestType || 'direct_buy') === 'resell_request'
          ? 'admin_resell_seed_purchase'
          : 'admin_bot_purchase',
      direction: 'to_admin',
      broker: b.broker,
      accountNumber: b.accountNumber,
      paymentSlip: b.paymentSlip || null,
      createdAt: new Date().toISOString(),
    });

    if (user) {
      db.notifications.push({
        id: Date.now() + 1,
        uid: user.uid,
        type:
          (b.requestType || 'direct_buy') === 'resell_request'
            ? 'admin_resell_request_approved'
            : 'admin_bot_purchase_approved',
        message:
          (b.requestType || 'direct_buy') === 'resell_request'
            ? `Your reseller request for "${b.botName}" was approved. This bot is now eligible for resale.`
            : `Your bot purchase for "${b.botName}" was approved by admin.`,
        read: false,
        createdAt: new Date().toISOString(),
      });
    }

    await writeDbAndWait(db);
    res.json({ message: 'Bot request approved', bot: b });
  } catch (error) {
    console.error('Failed to approve bot request:', error);
    res.status(500).json({ message: error.message || 'Failed to approve bot request' });
  }
});

// Reject bot request
app.put('/api/admin/bot-requests/:id/reject', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const db = readDb();
    ensureBotsArray(db);

    const b = db.bots.find(x => x.id === id);
    if (!b) return res.status(404).json({ message: 'Bot request not found' });

    b.status = 'rejected';
    await writeDbAndWait(db);
    res.json({ message: 'Bot request rejected', bot: b });
  } catch (error) {
    console.error('Failed to reject bot request:', error);
    res.status(500).json({ message: error.message || 'Failed to reject bot request' });
  }
});

// ---------------- BOT RESALE MARKETPLACE ----------------

// User: List a bot for resale
app.post('/api/users/:uid/bots/:botId/resell', async (req, res) => {
  const { uid, botId } = req.params;
  const { resalePrice } = req.body;

  if (resalePrice == null || resalePrice < 0) {
    return res.status(400).json({ message: 'Valid resalePrice is required' });
  }

  const db = readDb();
  ensureBotsArray(db);

  const userBot = db.bots.find(b => b.id === Number(botId) && b.uid === uid);
  if (!userBot) {
    return res.status(404).json({ message: 'Bot not found or does not belong to user' });
  }

  if (userBot.status !== 'approved') {
    return res.status(400).json({ message: 'Only approved bots can be resold' });
  }

  if (userBot.boughtFrom) {
    return res.status(400).json({ message: 'Bots purchased from other resellers cannot be resold again' });
  }

  if (!userBot.canResell) {
    return res.status(400).json({ message: 'This bot is a direct purchase and is not eligible for resale' });
  }

  userBot.isForResale = true;
  userBot.resalePrice = resalePrice;

  await writeDbAndWait(db);
  res.json({ message: 'Bot added to the shop', bot: userBot });
});

// User: Cancel resale listing
app.post('/api/users/:uid/bots/:botId/cancel-resale', async (req, res) => {
  const { uid, botId } = req.params;
  const db = readDb();
  ensureBotsArray(db);

  const userBot = db.bots.find(b => b.id === Number(botId) && b.uid === uid);
  if (!userBot) {
    return res.status(404).json({ message: 'Bot not found or does not belong to user' });
  }

  userBot.isForResale = false;
  userBot.resalePrice = null;

  await writeDbAndWait(db);
  res.json({ message: 'Bot removed from the shop', bot: userBot });
});
// GET: All bots available for resale (Marketplace)
app.get('/api/bots/resale', (req, res) => {
  const { buyerUid } = req.query;
  const db = readDb();
  ensureBotsArray(db);

  let marketplace = db.bots.filter(b => b.isForResale);

  if (buyerUid) {
    const viewer = db.users.find(u => u.uid === buyerUid);
    if (viewer) {
      const hasOwnResaleListings = db.bots.some(
        b => b.uid === viewer.uid && b.isForResale
      );

      if (viewer.referredBy) {
        // Referred users only see bots from their referrer
        marketplace = marketplace.filter(b => b.uid === viewer.referredBy);
      } else if (hasOwnResaleListings) {
        // Resellers only see their own marketplace listings
        marketplace = marketplace.filter(b => b.uid === viewer.uid);
      }
    }
  }

  const results = marketplace.map(b => {
    const seller = db.users.find(u => u.uid === b.uid);
    return {
      ...b,
      sellerName: seller ? seller.name : 'Unknown Operator',
    };
  });

  res.json(sortNewest(results, 'createdAt'));
});

// Helper for resale arrays
function ensureResaleArrays(db) {
  if (!Array.isArray(db.resaleRequests)) db.resaleRequests = [];
  if (!Array.isArray(db.resaleHistory)) db.resaleHistory = [];
}

function createAdminCommissionSubmission(db, request, targetBot, buyer, seller) {
  ensurePaymentArrays(db);

  if (request.adminSubmissionId) {
    return db.adminCommissionSubmissions.find(
      item => item.id === request.adminSubmissionId
    );
  }

  const adminBasePrice = Number(targetBot.adminBasePrice ?? targetBot.price ?? 0);
  const adminPayablePrice = calculateAdminPayablePrice(adminBasePrice);
  const resalePrice = Number(request.price || 0);
  const resellerEarning = calculateResellerEarning(adminBasePrice, resalePrice);
  const submission = {
    id: Date.now() + Math.floor(Math.random() * 1000),
    requestId: request.id,
    resellerUid: seller.uid,
    resellerName: seller.name,
    resellerEmail: seller.email,
    buyerUid: buyer.uid,
    buyerName: buyer.name,
    botName: request.botName,
    broker: request.broker,
    accountNumber: request.accountNumber,
    amountInAsset: request.amountInAsset,
    resalePrice,
    adminBasePrice,
    adminPayablePrice,
    commissionAmount: resellerEarning,
    resellerAdminPaymentSlip: targetBot.paymentSlip || null,
    customerPaymentSlip: request.paymentSlip,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };

  db.adminCommissionSubmissions.push(submission);
  request.adminSubmissionId = submission.id;
  request.sentToAdminAt = submission.createdAt;
  return submission;
}

function finalizeResaleApproval(db, request, submission) {
  ensureBotsArray(db);
  ensureResaleArrays(db);
  ensurePaymentArrays(db);
  ensureNotificationsArray(db);

  const targetBot = db.bots.find(b => b.id === request.botInstanceId);
  if (!targetBot) return { error: 'Original bot instance not found' };

  const buyer = db.users.find(u => u.uid === request.buyerUid);
  const seller = db.users.find(u => u.uid === request.sellerUid);
  if (!buyer || !seller) return { error: 'Buyer or seller not found' };
  const resellerEarning = calculateResellerEarning(
    targetBot.adminBasePrice ?? targetBot.price ?? 0,
    request.price
  );
  const adminPayablePrice = calculateAdminPayablePrice(
    targetBot.adminBasePrice ?? targetBot.price ?? 0
  );

  let buyerAccount = db.accounts.find(
    a =>
      a.uid === request.buyerUid &&
      a.broker === request.broker &&
      a.accountNumber === request.accountNumber
  );

  if (!buyerAccount) {
    buyerAccount = {
      id: Date.now() + Math.floor(Math.random() * 1000),
      uid: request.buyerUid,
      broker: request.broker,
      accountType: 'Marketplace Purchase',
      accountNumber: request.accountNumber,
    };
    db.accounts.push(buyerAccount);
  }

  seller.totalSells = (seller.totalSells || 0) + 1;
  seller.totalRevenue = (seller.totalRevenue || 0) + resellerEarning;

  const newBotInstance = {
    ...targetBot,
    id: Date.now() + Math.floor(Math.random() * 1000),
    uid: request.buyerUid,
    brokerAccountId: buyerAccount.id,
    broker: buyerAccount.broker,
    accountNumber: buyerAccount.accountNumber,
    accountType: buyerAccount.accountType || 'Marketplace Purchase',
    isForResale: false,
    resalePrice: null,
    price: request.price,
    amountInAsset: request.amountInAsset,
    boughtFrom: seller.name,
    status: 'approved',
    createdAt: new Date().toISOString(),
  };

  db.bots.push(newBotInstance);

  db.paymentRecords.push({
    id: Date.now() + 10,
    uid: buyer.uid,
    userName: buyer.name,
    botId: newBotInstance.id,
    botName: targetBot.botName,
    amount: Number(request.price) || 0,
    category: 'resale_customer_payment',
    direction: 'to_reseller',
    broker: request.broker,
    accountNumber: request.accountNumber,
    paymentSlip: request.paymentSlip,
    createdAt: new Date().toISOString(),
  });

  db.paymentRecords.push({
    id: Date.now() + 20,
    uid: seller.uid,
    userName: seller.name,
    botId: targetBot.id,
    botName: targetBot.botName,
    amount: Number(request.price) || 0,
    category: 'resale_client_payment',
    direction: 'to_reseller',
    broker: request.broker,
    accountNumber: request.accountNumber,
    paymentSlip: request.paymentSlip,
    createdAt: new Date().toISOString(),
  });

  db.paymentRecords.push({
    id: Date.now() + 30,
    uid: seller.uid,
    userName: seller.name,
    botId: targetBot.id,
    botName: targetBot.botName,
    amount: adminPayablePrice,
    category: 'resale_admin_payment',
    direction: 'to_admin',
    broker: request.broker,
    accountNumber: request.accountNumber,
    paymentSlip: submission.resellerAdminPaymentSlip,
    createdAt: new Date().toISOString(),
  });

  db.resaleHistory.push({
    id: Date.now() + 50,
    requestId: request.id,
    botName: targetBot.botName,
    sellerUid: seller.uid,
    sellerName: seller.name,
    buyerUid: buyer.uid,
    buyerName: buyer.name,
    price: request.price,
    adminBasePrice: Number(targetBot.adminBasePrice ?? targetBot.price ?? 0),
    adminPayablePrice,
    profit: resellerEarning,
    broker: request.broker,
    accountNumber: request.accountNumber,
    amountInAsset: request.amountInAsset,
    adminPaymentSlip: submission.resellerAdminPaymentSlip,
    date: new Date().toISOString()
  });

  request.status = 'approved';
  submission.status = 'approved';
  submission.approvedAt = new Date().toISOString();

  db.notifications.push({
    id: Date.now() + 1,
    uid: seller.uid,
    type: 'bot_sold',
    message: `Admin approved your sale for "${targetBot.botName}". Profit: $${resellerEarning}.`,
    read: false,
    createdAt: new Date().toISOString()
  });

  db.notifications.push({
    id: Date.now() + 2,
    uid: buyer.uid,
    type: 'bot_purchased',
    message: `Admin approved your request for "${targetBot.botName}" and the bot is now in My Bots.`,
    read: false,
    createdAt: new Date().toISOString()
  });

  return { request, submission };
}

// User: Request to purchase a bot from resale marketplace
app.post('/api/bots/resale/request', async (req, res) => {
  const {
    uid,
    botInstanceId,
    paymentSlip,
    broker,
    accountNumber,
    amountInAsset,
  } = req.body;

  if (!uid || !botInstanceId || !paymentSlip || !broker || !accountNumber || amountInAsset == null) {
    return res.status(400).json({
      message:
        'Missing required fields: uid, botInstanceId, broker, accountNumber, amountInAsset, paymentSlip',
    });
  }

  if (Number(amountInAsset) < 0) {
    return res.status(400).json({ message: 'amountInAsset must be zero or greater' });
  }

  const db = readDb();
  ensureBotsArray(db);
  ensureResaleArrays(db);

  const targetBot = db.bots.find(b => b.id === Number(botInstanceId));
  if (!targetBot || !targetBot.isForResale) {
    return res.status(404).json({ message: 'Bot listing not found in marketplace' });
  }

  if (targetBot.uid === uid) {
    return res.status(400).json({ message: 'You cannot buy your own bot' });
  }

  const buyer = db.users.find(u => u.uid === uid);
  if (!buyer) return res.status(404).json({ message: 'Buyer not found' });

  const newRequest = {
    id: Date.now(),
    botInstanceId: Number(botInstanceId),
    sellerUid: targetBot.uid,
    buyerUid: uid,
    buyerName: buyer.name,
    botName: targetBot.botName,
    price: targetBot.resalePrice,
    broker,
    accountNumber,
    amountInAsset: Number(amountInAsset),
    paymentSlip,
    status: 'pending',
    adminSubmissionId: null,
    sentToAdminAt: null,
    createdAt: new Date().toISOString(),
  };

  db.resaleRequests.push(newRequest);
  await writeDbAndWait(db);

  res.status(201).json({ message: 'Purchase request submitted', request: newRequest });
});

// User: Get requests for my listed bots (as seller)
app.get('/api/users/:uid/seller-requests', (req, res) => {
  const { uid } = req.params;
  const db = readDb();
  ensureResaleArrays(db);

  const myRequests = db.resaleRequests
    .filter(r => r.sellerUid === uid)
    .map(request => {
      const targetBot = db.bots.find(b => b.id === request.botInstanceId);
      return {
        ...request,
        adminBasePrice: Number(targetBot?.adminBasePrice ?? targetBot?.price ?? 0),
        adminPayablePrice: calculateAdminPayablePrice(
          Number(targetBot?.adminBasePrice ?? targetBot?.price ?? 0)
        ),
      };
    });
  res.json(sortNewest(myRequests, 'createdAt'));
});

app.post('/api/bots/resale/requests/:requestId/send-to-admin', async (req, res) => {
  const { requestId } = req.params;
  const { adminPaymentSlip } = req.body;
  const db = readDb();
  ensureResaleArrays(db);
  ensureBotsArray(db);
  ensurePaymentArrays(db);

  const request = db.resaleRequests.find(r => r.id === Number(requestId));
  if (!request) return res.status(404).json({ message: 'Request not found' });
  if (request.status !== 'pending') {
    return res.status(400).json({ message: 'Request already processed' });
  }

  const targetBot = db.bots.find(b => b.id === request.botInstanceId);
  if (!targetBot) {
    return res.status(404).json({ message: 'Original bot instance not found' });
  }

  const buyer = db.users.find(u => u.uid === request.buyerUid);
  const seller = db.users.find(u => u.uid === request.sellerUid);
  if (!buyer || !seller) {
    return res.status(404).json({ message: 'Buyer or seller not found' });
  }

  if (!adminPaymentSlip) {
    return res.status(400).json({ message: 'adminPaymentSlip is required' });
  }

  const submission = createAdminCommissionSubmission(db, request, targetBot, buyer, seller);
  submission.resellerAdminPaymentSlip = adminPaymentSlip;
  submission.status = 'pending';
  request.status = 'pending_admin';
  await writeDbAndWait(db);
  res.json({ message: 'Sent to admin for approval', submission, request });
});

// User: Approve or Decline resale request
app.post('/api/bots/resale/requests/:requestId/status', async (req, res) => {
  const { requestId } = req.params;
  const { status, adminPaymentSlip } = req.body; // 'approved' | 'rejected'

  if (!['approved', 'rejected'].includes(status)) {
    return res.status(400).json({ message: 'Invalid status' });
  }

  const db = readDb();
  ensureResaleArrays(db);
  ensureBotsArray(db);
  ensureNotificationsArray(db);

  const request = db.resaleRequests.find(r => r.id === Number(requestId));
  if (!request) return res.status(404).json({ message: 'Request not found' });

  if (request.status !== 'pending') {
    return res.status(400).json({ message: 'Request already processed' });
  }

  if (status === 'approved') {
    if (!adminPaymentSlip) {
      return res.status(400).json({
        message: 'adminPaymentSlip is required to approve a resale request',
      });
    }
    const targetBot = db.bots.find(b => b.id === request.botInstanceId);
    if (!targetBot) return res.status(404).json({ message: 'Original bot instance not found' });
    const buyer = db.users.find(u => u.uid === request.buyerUid);
    const seller = db.users.find(u => u.uid === request.sellerUid);
    if (!buyer || !seller) {
      return res.status(404).json({ message: 'Buyer or seller not found' });
    }

    const submission = createAdminCommissionSubmission(db, request, targetBot, buyer, seller);
    submission.resellerAdminPaymentSlip = adminPaymentSlip;
    submission.status = 'pending';
    submission.updatedAt = new Date().toISOString();
    request.status = 'pending_admin';

    db.notifications.push({
      id: Date.now() + 1,
      uid: seller.uid,
      type: 'resale_pending_admin',
      message: `Your sale for "${request.botName}" was sent to admin for final approval.`,
      read: false,
      createdAt: new Date().toISOString()
    });

    db.notifications.push({
      id: Date.now() + 2,
      uid: buyer.uid,
      type: 'resale_pending_admin',
      message: `Your request for "${request.botName}" is waiting for admin approval.`,
      read: false,
      createdAt: new Date().toISOString()
    });
  } else {
    // Rejected: Notify buyer
    request.status = 'rejected';
    db.notifications.push({
      id: Date.now() + 3,
      uid: request.buyerUid,
      type: 'bot_declined',
      message: `Your request for "${request.botName}" was declined by the seller.`,
      read: false,
      createdAt: new Date().toISOString()
    });
  }

  await writeDbAndWait(db);
  res.json({
    message:
      status === 'approved'
        ? 'Request sent to admin for approval'
        : 'Request rejected',
    request,
  });
});

// User: Get sale history (as seller)
app.get('/api/users/:uid/sale-history', (req, res) => {
  const { uid } = req.params;
  const db = readDb();
  ensureResaleArrays(db);
  const history = sortNewest(
    db.resaleHistory.filter(h => h.sellerUid === uid),
    'date'
  );
  res.json(history);
});

// Admin: Get all resale history
app.get('/api/admin/resale-history', (req, res) => {
  const db = readDb();
  ensureResaleArrays(db);
  res.json(sortNewest(db.resaleHistory || [], 'date'));
});

app.get('/api/admin/resale-approvals', (req, res) => {
  const db = readDb();
  ensurePaymentArrays(db);
  const submissions = [...db.adminCommissionSubmissions].sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );
  res.json(submissions);
});

app.get('/api/admin/resale-approvals/:id', (req, res) => {
  const id = Number(req.params.id);
  const db = readDb();
  ensurePaymentArrays(db);
  const submission = db.adminCommissionSubmissions.find(item => item.id === id);
  if (!submission) {
    return res.status(404).json({ message: 'Resale approval not found' });
  }
  res.json(submission);
});

app.put('/api/admin/resale-approvals/:id/approve', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const db = readDb();
    ensurePaymentArrays(db);
    ensureResaleArrays(db);

    const submission = db.adminCommissionSubmissions.find(item => item.id === id);
    if (!submission) {
      return res.status(404).json({ message: 'Resale approval not found' });
    }
    if (submission.status !== 'pending') {
      return res.status(400).json({ message: 'Submission already processed' });
    }

    const request = db.resaleRequests.find(item => item.id === submission.requestId);
    if (!request) {
      return res.status(404).json({ message: 'Linked resale request not found' });
    }

    const result = finalizeResaleApproval(db, request, submission);
    if (result.error) {
      return res.status(400).json({ message: result.error });
    }

    await writeDbAndWait(db);
    res.json({ message: 'Resale approved', submission, request });
  } catch (error) {
    console.error('Failed to approve resale submission:', error);
    res.status(500).json({ message: error.message || 'Failed to approve resale submission' });
  }
});

app.put('/api/admin/resale-approvals/:id/reject', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const db = readDb();
    ensurePaymentArrays(db);
    ensureResaleArrays(db);
    ensureNotificationsArray(db);

    const submission = db.adminCommissionSubmissions.find(item => item.id === id);
    if (!submission) {
      return res.status(404).json({ message: 'Resale approval not found' });
    }
    if (submission.status !== 'pending') {
      return res.status(400).json({ message: 'Submission already processed' });
    }

    const request = db.resaleRequests.find(item => item.id === submission.requestId);
    if (request) {
      request.status = 'rejected';
    }
    submission.status = 'rejected';
    submission.rejectedAt = new Date().toISOString();

    db.notifications.push({
      id: Date.now() + 1,
      uid: submission.resellerUid,
      type: 'resale_admin_rejected',
      message: `Admin rejected the resale submission for "${submission.botName}".`,
      read: false,
      createdAt: new Date().toISOString()
    });

    db.notifications.push({
      id: Date.now() + 2,
      uid: submission.buyerUid,
      type: 'resale_admin_rejected',
      message: `Admin rejected your request for "${submission.botName}".`,
      read: false,
      createdAt: new Date().toISOString()
    });

    await writeDbAndWait(db);
    res.json({ message: 'Resale rejected', submission, request });
  } catch (error) {
    console.error('Failed to reject resale submission:', error);
    res.status(500).json({ message: error.message || 'Failed to reject resale submission' });
  }
});

app.get('/api/users/:uid/dashboard-payments', (req, res) => {
  const { uid } = req.params;
  const db = readDb();
  ensurePaymentArrays(db);
  ensureResaleArrays(db);

  const user = db.users.find(u => u.uid === uid);
  if (!user) return res.status(404).json({ message: 'User not found' });

  const payments = db.paymentRecords
    .filter(record => record.uid === uid)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const adminPurchases = payments.filter(
    record =>
      record.category === 'admin_bot_purchase' ||
      record.category === 'resale_admin_payment'
  );
  const clientPayments = payments.filter(
    record => record.category === 'resale_client_payment'
  );
  const customerPayments = payments.filter(
    record => record.category === 'resale_customer_payment'
  );

  const commissionSubmissions = db.adminCommissionSubmissions
    .filter(item => item.resellerUid === uid || item.buyerUid === uid)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const resellerHistory = db.resaleHistory.filter(item => item.sellerUid === uid);
  const months = Array.from(
    new Set([
      ...payments.map(item => getMonthKey(item.createdAt)),
      ...resellerHistory.map(item => getMonthKey(item.date)),
    ])
  ).sort((a, b) => b.localeCompare(a));
  const currentMonth = months[0] || getMonthKey(new Date());

  const adminPaymentsByMonth = buildMonthlyMap(adminPurchases, item => item.amount, item => item.createdAt);
  const clientPaymentsByMonth = buildMonthlyMap(clientPayments, item => item.amount, item => item.createdAt);
  const profitsByMonth = buildMonthlyMap(resellerHistory, item => item.profit, item => item.date);

  res.json({
    summary: {
      adminPaymentsTotal: adminPurchases.reduce((sum, item) => sum + (Number(item.amount) || 0), 0),
      clientPaymentsTotal: clientPayments.reduce((sum, item) => sum + (Number(item.amount) || 0), 0),
      customerPaymentsTotal: customerPayments.reduce((sum, item) => sum + (Number(item.amount) || 0), 0),
      commissionTotal: commissionSubmissions.reduce(
        (sum, item) => sum + (Number(item.commissionAmount) || 0),
        0
      ),
    },
    currentMonth,
    monthOptions: months.map(month => ({ value: month, label: monthLabel(month) })),
    monthly: {
      adminPayments: adminPaymentsByMonth,
      clientPayments: clientPaymentsByMonth,
      profits: profitsByMonth,
    },
    monthlyHistory: {
      adminPayments: toMonthlyHistory(months, monthLabel, adminPaymentsByMonth),
      clientPayments: toMonthlyHistory(months, monthLabel, clientPaymentsByMonth),
      profits: toMonthlyHistory(months, monthLabel, profitsByMonth),
    },
    adminPurchases,
    clientPayments,
    customerPayments,
    commissionSubmissions,
  });
});

app.get('/api/admin/dashboard-payments', (req, res) => {
  const db = readDb();
  ensurePaymentArrays(db);

  const adminPurchases = db.paymentRecords
    .filter(
      record =>
        record.category === 'admin_bot_purchase' ||
        record.category === 'resale_admin_payment'
    )
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const clientPayments = db.paymentRecords
    .filter(record => record.category === 'resale_customer_payment')
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const commissionSubmissions = [...db.adminCommissionSubmissions].sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );

  const months = Array.from(
    new Set([
      ...adminPurchases.map(item => getMonthKey(item.createdAt)),
      ...clientPayments.map(item => getMonthKey(item.createdAt)),
      ...commissionSubmissions.map(item => getMonthKey(item.createdAt)),
    ])
  ).sort((a, b) => b.localeCompare(a));
  const currentMonth = months[0] || getMonthKey(new Date());
  const adminPaymentsByMonth = buildMonthlyMap(adminPurchases, item => item.amount, item => item.createdAt);
  const clientPaymentsByMonth = buildMonthlyMap(clientPayments, item => item.amount, item => item.createdAt);
  const commissionsByMonth = buildMonthlyMap(
    commissionSubmissions,
    item => item.commissionAmount,
    item => item.createdAt
  );

  res.json({
    summary: {
      adminPaymentsTotal: adminPurchases.reduce((sum, item) => sum + (Number(item.amount) || 0), 0),
      clientPaymentsTotal: clientPayments.reduce((sum, item) => sum + (Number(item.amount) || 0), 0),
      commissionTotal: commissionSubmissions.reduce(
        (sum, item) => sum + (Number(item.commissionAmount) || 0),
        0
      ),
    },
    currentMonth,
    monthOptions: months.map(month => ({ value: month, label: monthLabel(month) })),
    monthly: {
      adminPayments: adminPaymentsByMonth,
      clientPayments: clientPaymentsByMonth,
      commissions: commissionsByMonth,
    },
    monthlyHistory: {
      adminPayments: toMonthlyHistory(months, monthLabel, adminPaymentsByMonth),
      clientPayments: toMonthlyHistory(months, monthLabel, clientPaymentsByMonth),
      commissions: toMonthlyHistory(months, monthLabel, commissionsByMonth),
    },
    adminPurchases,
    clientPayments,
    commissionSubmissions,
  });
});

// (Old direct purchase logic removed in favor of request/approve workflow)

// ---------------- CAREERS ----------------

// User: submit career application
app.post('/api/careers', async (req, res) => {
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
  await writeDbAndWait(db);

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

function ensureNotificationsArray(db) {
  if (!db.notifications) db.notifications = [];
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
app.post('/api/admin/courses', async (req, res) => {
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
    await writeDbAndWait(db);
    res.status(201).json(newCourse);
  } catch (err) {
    res.status(400).json({ error: 'Failed to create course' });
  }
});

// Admin: Update course
app.put('/api/admin/courses/:id', async (req, res) => {
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

    await writeDbAndWait(db);
    res.json(course);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update course' });
  }
});

// Admin: Delete course
app.delete('/api/admin/courses/:id', async (req, res) => {
  try {
    const db = readDb();
    ensureCoursesArray(db);
    const id = Number(req.params.id);
    const index = db.courses.findIndex(c => c.id === id);
    if (index === -1) return res.status(404).json({ error: 'Course not found' });

    db.courses.splice(index, 1);
    await writeDbAndWait(db);
    res.json({ message: 'Course deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Delete failed' });
  }
});

// ---------------- COURSE APPLICATIONS ----------------

// User: submit course application with payment slip (base64 or URL)
app.post('/api/courses/apply', async (req, res) => {
  try {
    const {
      courseId,
      name,
      email,
      phone,
      notes,
      paymentSlip, // string: base64 image or URL
      uid, // User sending the request
    } = req.body;

    if (!courseId || !name || !email || !paymentSlip || !uid) {
      return res.status(400).json({ error: 'courseId, name, email, paymentSlip, uid are required' });
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
      uid, // Used for notifications
      status: 'pending',
      createdAt: new Date().toISOString(),
    };

    db.courseApplications.push(appRecord);
    await writeDbAndWait(db);

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
app.put('/api/admin/course-applications/:id/status', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { status } = req.body; // 'pending' | 'approved' | 'rejected'
    const db = readDb();
    ensureCourseApplicationsArray(db);

    const appRecord = db.courseApplications.find(a => a.id === id);
    if (!appRecord) {
      return res.status(404).json({ error: 'Application not found' });
    }

    if (status && appRecord.status !== status) {
      appRecord.status = status;

      // Attempt to send notification if a valid user applied
      if (appRecord.uid && (status === 'approved' || status === 'rejected')) {
        ensureNotificationsArray(db);
        db.notifications.push({
          id: Date.now() + Math.floor(Math.random() * 1000),
          uid: appRecord.uid,
          courseId: appRecord.courseId,
          type: 'course_application',
          message: `Your application for course "${appRecord.courseTitle}" has been ${status}.`,
          read: false,
          createdAt: new Date().toISOString(),
          status: status
        });
      }
    }

    await writeDbAndWait(db);
    res.json(appRecord);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update application status' });
  }
});


// ---------------- NOTIFICATIONS ----------------
app.get('/api/users/:uid/notifications', (req, res) => {
  try {
    const db = readDb();
    ensureNotificationsArray(db);
    const userNotifs = db.notifications
      .filter(n => n.uid === req.params.uid)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(userNotifs);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

app.put('/api/users/:uid/notifications/:notifId/read', async (req, res) => {
  try {
    const db = readDb();
    ensureNotificationsArray(db);
    const notif = db.notifications.find(
      n => n.id === Number(req.params.notifId) && n.uid === req.params.uid
    );
    if (notif) {
      notif.read = true;
      await writeDbAndWait(db);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update notification' });
  }
});

app.delete('/api/users/:uid/notifications', async (req, res) => {
  try {
    const db = readDb();
    ensureNotificationsArray(db);
    db.notifications = db.notifications.filter(n => n.uid !== req.params.uid);
    await writeDbAndWait(db);
    res.json({ success: true, deleted: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete notifications' });
  }
});

// ---------------- ADMIN MAINTENANCE ----------------

app.post('/api/admin/reset-data', async (req, res) => {
  try {
    const token = req.headers['x-admin-reset-token'];
    const expected = process.env.ADMIN_RESET_TOKEN;

    // Require token when configured to avoid accidental public resets.
    if (expected && token !== expected) {
      return res.status(401).json({ message: 'Unauthorized reset token' });
    }

    const emptyDb = createInitialDb();
    await writeDbAndWait(emptyDb);

    res.json({
      success: true,
      message: 'All application data has been reset',
      collection: FIRESTORE_COLLECTION,
      document: FIRESTORE_DOC,
    });
  } catch (error) {
    console.error('Failed to reset data:', error);
    res.status(500).json({ message: 'Failed to reset data' });
  }
});

// ---------------- SERVER ----------------
app.get('/api/users/:uid/course-applications', (req, res) => {
  try {
    const db = readDb();
    ensureCourseApplicationsArray(db);
    ensureCoursesArray(db);

    const userApps = sortNewest(
      db.courseApplications.filter(a => a.uid === req.params.uid),
      'createdAt'
    );

    // Join with courses to get full details (description, youtubeLinks, etc.)
    const enrichedApps = userApps.map(app => {
      const course = db.courses.find(c => c.id === app.courseId);
      return {
        ...app,
        courseDescription: course ? course.description : '',
        youtubeLinks: course ? course.youtubeLinks : [],
        duration: course ? course.duration : '',
        level: course ? course.level : '',
        location: course ? course.location : '',
        date: course ? course.date : '',
        thumbnail: course ? course.thumbnail : '',
      };
    });

    res.json(enrichedApps);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch user course applications' });
  }
});

app.use((err, req, res, next) => {
  console.error('Unhandled API error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ message: err?.message || 'Internal server error' });
});

const PORT = Number(process.env.PORT || 5000);

async function startServer() {
  try {
    await loadDbFromFirestore();
    app.listen(PORT, () => {
      console.log(`Backend API running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to initialize Firestore persistence:', error);
    process.exit(1);
  }
}

startServer();

