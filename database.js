
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const dataFolder = path.join(__dirname, "data");

if (!fs.existsSync(dataFolder)) {
  fs.mkdirSync(dataFolder, { recursive: true });
}

const db = new Database(
  path.join(dataFolder, "mfaarhyaadm.db")
);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS wallets (
    user_id INTEGER PRIMARY KEY,
    balance_pkr INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS wallet_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    amount_pkr INTEGER NOT NULL,
    description TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);


db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);
const userColumns = db.prepare("PRAGMA table_info(users)").all();

if (!userColumns.some(column => column.name === "is_blocked")) {
  db.exec(`
    ALTER TABLE users
    ADD COLUMN is_blocked INTEGER NOT NULL DEFAULT 0
  `);
}
// Referral system: store who referred each user
const referralColumns = db.prepare(
  "PRAGMA table_info(users)"
).all();

if (!referralColumns.some(column => column.name === "referred_by")) {
  db.exec(`
    ALTER TABLE users
    ADD COLUMN referred_by INTEGER
    REFERENCES users(id)
  `);
}

// Give every user a unique referral code
if (!referralColumns.some(column => column.name === "referral_code")) {
  db.exec(`
    ALTER TABLE users
    ADD COLUMN referral_code TEXT
  `);
}

const usersWithoutCode = db.prepare(`
  SELECT id FROM users
  WHERE referral_code IS NULL OR referral_code = ''
`).all();

const updateReferralCode = db.prepare(`
  UPDATE users SET referral_code = ?
  WHERE id = ?
`);

for (const user of usersWithoutCode) {
  updateReferralCode.run(
    "MF" + user.id + "-" + Math.random().toString(36).slice(2, 8).toUpperCase(),
    user.id
  );
}

db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_code
  ON users(referral_code)
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    reward_pkr INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS task_completions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    task_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'completed',
    completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, task_id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (task_id) REFERENCES tasks(id)
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS task_daily_completions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    task_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'completed',
    completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completion_date TEXT NOT NULL DEFAULT (date('now', 'localtime')),
    UNIQUE(user_id, task_id, completion_date),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (task_id) REFERENCES tasks(id)
  );
`);

const taskCount = db.prepare(
  "SELECT COUNT(*) AS count FROM tasks"
).get().count;

if (taskCount === 0) {
  const addTask = db.prepare(`
    INSERT INTO tasks (title, description, reward_pkr)
    VALUES (?, ?, ?)
  `);

  const addDemoTasks = db.transaction(() => {
    addTask.run(
      "Complete Your Profile",
      "Check your demo account details.",
      10
    );

    addTask.run(
      "Explore the Dashboard",
      "Explore the different sections of the website.",
      15
    );

    addTask.run(
      "Read Platform Guidelines",
      "Read the rules and learn how the platform works.",
      20
    );
  });

  addDemoTasks();
}

/* DEMO PACKAGES AND REFERRAL COMMISSION TABLES */

db.exec(`
  CREATE TABLE IF NOT EXISTS packages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    price_pkr INTEGER NOT NULL CHECK (price_pkr > 0),
    description TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS user_packages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    package_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'demo_active'
      CHECK (status IN ('demo_active', 'cancelled')),
    activated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (package_id) REFERENCES packages(id)
  );

  CREATE TABLE IF NOT EXISTS referral_commissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    referrer_user_id INTEGER NOT NULL,
    referred_user_id INTEGER NOT NULL,
    user_package_id INTEGER NOT NULL,
    package_price_pkr INTEGER NOT NULL,
    commission_rate INTEGER NOT NULL DEFAULT 20
      CHECK (commission_rate = 20),
    commission_pkr INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'demo_only'
      CHECK (status IN ('demo_only', 'cancelled')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (user_package_id),
    FOREIGN KEY (referrer_user_id) REFERENCES users(id),
    FOREIGN KEY (referred_user_id) REFERENCES users(id),
    FOREIGN KEY (user_package_id) REFERENCES user_packages(id)
  );
`);

const packageCount = db.prepare(
  "SELECT COUNT(*) AS count FROM packages"
).get().count;

if (packageCount === 0) {
  const addPackage = db.prepare(`
    INSERT INTO packages (name, price_pkr, description)
    VALUES (?, ?, ?)
  `);

  addPackage.run(
    "Starter Demo",
    500,
    "Demo package for testing."
  );

  addPackage.run(
    "Growth Demo",
    1000,
    "Demo package with referral calculations."
  );

  addPackage.run(
    "Premium Demo",
    2500,
    "Demo package for testing package management."
  );
}

console.log("Database connected successfully!");
console.log(
  "TOTAL USERS IN DATABASE:",
  db.prepare("SELECT COUNT(*) AS total FROM users").get().total
);

module.exports = db;
