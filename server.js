
const express = require("express");
const path = require("path");
const bcrypt = require("bcryptjs");
const session = require("express-session");
const db = require("./database");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 60
  }
}));

app.post("/api/signup", (req, res) => {
  const { username, email, password } = req.body;
  const referralCode = req.body.referralCode;

  if (
    typeof username !== "string" ||
    typeof email !== "string" ||
    typeof password !== "string" ||
    username.trim().length < 3 ||
    username.trim().length > 30 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ||
    password.length < 8 ||
    password.length > 72
  ) {
    return res.status(400).json({
      message: "Valid username, email aur password (8-72 characters) enter karo."
    });
  }

  try {
    let referrer = null;

    if (referralCode !== undefined && referralCode !== "") {
      if (typeof referralCode !== "string") {
        return res.status(400).json({
          message: "Referral code valid nahi hai."
        });
      }

      referrer = db.prepare(`
        SELECT id FROM users WHERE referral_code = ?
      `).get(referralCode.trim());

      if (!referrer) {
        return res.status(400).json({
          message: "Referral code valid nahi hai."
        });
      }
    }

    const hash = bcrypt.hashSync(password, 12);

    const createUser = db.transaction(() => {
      const result = db.prepare(`
        INSERT INTO users
          (username, email, password_hash, referred_by)
        VALUES (?, ?, ?, ?)
      `).run(
        username.trim(),
        email.trim().toLowerCase(),
        hash,
        referrer ? referrer.id : null
      );

      const userId = Number(result.lastInsertRowid);
      const code = "MF" + userId + "-" +
        require("crypto").randomBytes(4).toString("hex").toUpperCase();

      db.prepare(`
        UPDATE users SET referral_code = ? WHERE id = ?
      `).run(code, userId);

      return { id: userId, code };
    });

    const newUser = createUser();

    req.session.userId = newUser.id;

    res.status(201).json({
      message: "Account successfully created!",
      user: {
        id: newUser.id,
        username: username.trim()
      }
    });
  } catch (error) {
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE") {
      return res.status(409).json({
        message: "Username ya email pehle se registered hai."
      });
    }

    console.error("Signup error:", error.message);
    res.status(500).json({
      message: "Account create nahi ho saka."
    });
  }
});



app.post("/api/login", (req, res) => {
  const { email, password } = req.body;

  if (typeof email !== "string" || typeof password !== "string") {
    return res.status(400).json({
      message: "Email aur password required hain."
    });
  }

  const user = db.prepare(
    `SELECT id, username, email, password_hash, is_blocked
     FROM users
     WHERE email = ?`
  ).get(email.trim().toLowerCase());

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({
      message: "Email ya password ghalat hai."
    });
  }

  if (user.is_blocked === 1) {
    return res.status(403).json({
      message: "Aapka account block hai. Admin se rabta karein."
    });
  }

  req.session.regenerate((err) => {
    if (err) {
      return res.status(500).json({
        message: "Login nahi ho saka."
      });
    }

    req.session.userId = user.id;

    res.json({
      message: "Login successful!",
      user: {
        id: user.id,
        username: user.username
      }
    });
  });
});



app.get("/api/me", (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({
      message: "Login required hai."
    });
  }

  const user = db.prepare(`
    SELECT id, username, email, role, created_at, is_blocked
    FROM users
    WHERE id = ?
  `).get(req.session.userId);

  if (!user) {
    return res.status(401).json({
      message: "User nahi mila."
    });
  }

  res.json({
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      created_at: user.created_at,
      status: user.is_blocked ? "Blocked" : "Active"
    }
  });
});


app.get("/api/referral", (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({
      message: "Pehle login karo."
    });
  }

  const user = db.prepare(`
    SELECT referral_code
    FROM users
    WHERE id = ?
  `).get(req.session.userId);

  if (!user || !user.referral_code) {
    return res.status(404).json({
      message: "Referral code nahi mila."
    });
  }

  const referralUsers = db.prepare(`
    SELECT username, email, created_at
    FROM users
    WHERE referred_by = ?
    ORDER BY id DESC
  `).all(req.session.userId);

  res.json({
    referralCode: user.referral_code,
    referralLink:
      `${req.protocol}://${req.get("host")}/?ref=${encodeURIComponent(user.referral_code)}`,
    totalReferrals: referralUsers.length,
    referrals: referralUsers
  });
});


app.post("/api/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ message: "Logout nahi ho saka." });
    }

    res.clearCookie("connect.sid");
    res.json({ message: "Logout successful!" });
  });
});


app.get("/api/tasks", (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({
      message: "Pehle login karo."
    });
  }

  const tasks = db.prepare(`
    SELECT
      t.id,
      t.title,
      t.description,
      t.reward_pkr,
      CASE
        WHEN dc.id IS NOT NULL THEN 1
        ELSE 0
      END AS completed
    FROM tasks t
    LEFT JOIN task_daily_completions dc
      ON dc.task_id = t.id
      AND dc.user_id = ?
      AND dc.completion_date = date('now', 'localtime')
    WHERE t.is_active = 1
    ORDER BY t.id
  `).all(req.session.userId);

  res.json({ tasks });
});



app.post("/api/tasks/:id/complete", (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({
      message: "Pehle login karo."
    });
  }

  const taskId = Number(req.params.id);
  const userId = req.session.userId;

  if (!Number.isSafeInteger(taskId) || taskId < 1) {
    return res.status(400).json({
      message: "Task ID ghalat hai."
    });
  }

  try {
    const completeTask = db.transaction(() => {
      const task = db.prepare(`
        SELECT id, reward_pkr
        FROM tasks
        WHERE id = ? AND is_active = 1
      `).get(taskId);

      if (!task) {
        throw new Error("TASK_NOT_FOUND");
      }

      db.prepare(`
        INSERT INTO wallets (user_id, balance_pkr)
        VALUES (?, 0)
        ON CONFLICT(user_id) DO NOTHING
      `).run(userId);

      db.prepare(`
        INSERT INTO task_daily_completions (user_id, task_id)
        VALUES (?, ?)
      `).run(userId, taskId);

      db.prepare(`
        UPDATE wallets
        SET balance_pkr = balance_pkr + ?
        WHERE user_id = ?
      `).run(task.reward_pkr, userId);

      db.prepare(`
        INSERT INTO wallet_transactions
          (user_id, amount_pkr, description)
        VALUES (?, ?, ?)
      `).run(
        userId,
        task.reward_pkr,
        "Daily task reward: Task ID " + taskId
      );

      return task.reward_pkr;
    });

    const reward = completeTask();

    res.json({
      message: "Daily demo task complete! Reward wallet mein add ho gaya.",
      reward_pkr: reward
    });
  } catch (error) {
    if (error.message === "TASK_NOT_FOUND") {
      return res.status(404).json({
        message: "Active task nahi mila."
      });
    }

    if (error.code === "SQLITE_CONSTRAINT_UNIQUE") {
      return res.status(409).json({
        message: "Aaj ye task pehle hi complete kar chuke ho."
      });
    }

    console.error("Task completion error:", error.message);

    res.status(500).json({
      message: "Task complete nahi ho saka."
    });
  }
});




function requireAdmin(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({
      message: "Pehle login karo."
    });
  }

  const user = db.prepare(
    "SELECT role FROM users WHERE id = ?"
  ).get(req.session.userId);

  if (!user || user.role !== "admin") {
    return res.status(403).json({
      message: "Sirf admin is section ko access kar sakta hai."
    });
  }

  next();
}

// Admin dashboard statistics
app.get("/api/admin/stats", requireAdmin, (req, res) => {
  const users = db.prepare(
    "SELECT COUNT(*) AS total FROM users"
  ).get().total;

  const tasks = db.prepare(
    "SELECT COUNT(*) AS total FROM tasks"
  ).get().total;

  const completedTasks = db.prepare(
    "SELECT COUNT(*) AS total FROM task_completions"
  ).get().total;

  res.json({ users, tasks, completedTasks });
});


 // Registered users ki list
app.get("/api/admin/users", requireAdmin, (req, res) => {
  const users = db.prepare(`
    SELECT id, username, email, role, created_at, is_blocked
    FROM users
    ORDER BY id DESC
  `).all();

  res.json({ users });
});

// Block ya unblock user
app.patch("/api/admin/users/:id/block", requireAdmin, (req, res) => {
  const userId = Number(req.params.id);
  const { blocked } = req.body;

  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ message: "Invalid user ID." });
  }

  if (typeof blocked !== "boolean") {
    return res.status(400).json({
      message: "blocked true ya false hona chahiye."
    });
  }

  const targetUser = db.prepare(
    "SELECT id, role FROM users WHERE id = ?"
  ).get(userId);

  if (!targetUser) {
    return res.status(404).json({ message: "User nahi mila." });
  }

  if (targetUser.role === "admin") {
    return res.status(400).json({
      message: "Admin account ko yahan se block nahi kar sakte."
    });
  }

  db.prepare(
    "UPDATE users SET is_blocked = ? WHERE id = ?"
  ).run(blocked ? 1 : 0, userId);

  res.json({
    message: blocked ? "User block ho gaya." : "User unblock ho gaya."
  });
});

app.get("/api/wallet", (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({
      message: "Pehle login karo."
    });
  }

  db.prepare(`
    INSERT INTO wallets (user_id, balance_pkr)
    VALUES (?, 0)
    ON CONFLICT(user_id) DO NOTHING
  `).run(req.session.userId);

  const wallet = db.prepare(`
    SELECT balance_pkr
    FROM wallets
    WHERE user_id = ?
  `).get(req.session.userId);

  res.json({
    balance_pkr: wallet.balance_pkr,
    currency: "PKR",
    demo: true
  });
});

app.get("/api/wallet/history", (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({
      message: "Pehle login karo."
    });
  }

  const transactions = db.prepare(`
    SELECT id, amount_pkr, description, created_at
    FROM wallet_transactions
    WHERE user_id = ?
    ORDER BY id DESC
    LIMIT 50
  `).all(req.session.userId);

  res.json({
    transactions,
    demo: true
  });
});

// Naya task add karna
app.post("/api/admin/tasks", requireAdmin, (req, res) => {
  const { title, description, reward_pkr } = req.body;

  if (
    typeof title !== "string" ||
    title.trim().length < 3 ||
    title.trim().length > 100 ||
    typeof description !== "string" ||
    description.trim().length < 5 ||
    description.trim().length > 500 ||
    !Number.isSafeInteger(reward_pkr) ||
    reward_pkr < 0 ||
    reward_pkr > 10000
  ) {
    return res.status(400).json({
      message: "Task details check karo."
    });
  }

  const result = db.prepare(`
    INSERT INTO tasks (title, description, reward_pkr)
    VALUES (?, ?, ?)
  `).run(title.trim(), description.trim(), reward_pkr);

  res.status(201).json({
    message: "Task successfully add ho gaya!",
    taskId: result.lastInsertRowid
  });
});

function validTaskId(value) {
  return /^\d+$/.test(value) &&
    Number.isSafeInteger(Number(value)) &&
    Number(value) > 0;
}

// Admin ke tamam tasks dekhna
app.get("/api/admin/tasks", requireAdmin, (req, res) => {
  const tasks = db.prepare(`
    SELECT
      t.id,
      t.title,
      t.description,
      t.reward_pkr,
      t.is_active,
      COUNT(tc.id) AS completion_count
    FROM tasks t
    LEFT JOIN task_completions tc ON tc.task_id = t.id
    GROUP BY t.id
    ORDER BY t.id DESC
  `).all();

  res.json({ tasks });
});

// Task edit karna aur activate/deactivate karna
app.patch("/api/admin/tasks/:id", requireAdmin, (req, res) => {
  if (!validTaskId(req.params.id)) {
    return res.status(400).json({
      message: "Task ID ghalat hai."
    });
  }

  const { title, description, reward_pkr, is_active } = req.body;

  if (
    typeof title !== "string" ||
    title.trim().length < 3 ||
    title.trim().length > 100 ||
    typeof description !== "string" ||
    description.trim().length < 5 ||
    description.trim().length > 500 ||
    !Number.isSafeInteger(reward_pkr) ||
    reward_pkr < 0 ||
    reward_pkr > 10000 ||
    ![0, 1].includes(is_active)
  ) {
    return res.status(400).json({
      message: "Task ki details check karo."
    });
  }

  const result = db.prepare(`
    UPDATE tasks
    SET title = ?,
        description = ?,
        reward_pkr = ?,
        is_active = ?
    WHERE id = ?
  `).run(
    title.trim(),
    description.trim(),
    reward_pkr,
    is_active,
    Number(req.params.id)
  );

  if (result.changes === 0) {
    return res.status(404).json({
      message: "Task nahi mila."
    });
  }

  res.json({
    message: is_active
      ? "Task update aur activate ho gaya!"
      : "Task update aur deactivate ho gaya!"
  });
});

/* DEMO PACKAGES API */

app.get("/api/packages", (req, res) => {
  console.log("PACKAGES ROUTE HIT");

  try {
    const packages = db.prepare(`
      SELECT id, name, price_pkr, description
      FROM packages
      WHERE is_active = 1
      ORDER BY price_pkr ASC
    `).all();

    res.json({ success: true, packages });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Could not load packages." });
  }
});

app.post("/api/packages/activate-demo", (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({
      success: false,
      message: "Please login first."
    });
  }

  const packageId = Number(req.body.packageId);

  if (!Number.isInteger(packageId) || packageId <= 0) {
    return res.status(400).json({
      success: false,
      message: "Invalid package."
    });
  }

  try {
    const activateDemo = db.transaction(() => {
      const selectedPackage = db.prepare(`
        SELECT id, name, price_pkr
        FROM packages
        WHERE id = ? AND is_active = 1
      `).get(packageId);

      if (!selectedPackage) {
        throw new Error("Package not found.");
      }

      const existing = db.prepare(`
        SELECT id FROM user_packages
        WHERE user_id = ? AND package_id = ? AND status = 'demo_active'
      `).get(req.session.userId, packageId);

      if (existing) {
        throw new Error("You already activated this demo package.");
      }

      const result = db.prepare(`
        INSERT INTO user_packages (user_id, package_id)
        VALUES (?, ?)
      `).run(req.session.userId, packageId);

      const user = db.prepare(`
        SELECT referred_by FROM users WHERE id = ?
      `).get(req.session.userId);

      let commission = null;

      if (user && user.referred_by && Number(user.referred_by) !== Number(req.session.userId)) {
        const referrer = db.prepare(`
          SELECT id FROM users WHERE id = ?
        `).get(user.referred_by);

        if (referrer) {
          const commissionPkr = Math.round(selectedPackage.price_pkr * 0.20);

                  // Save demo referral commission
          db.prepare(`
            INSERT INTO referral_commissions
              (referrer_user_id, referred_user_id, user_package_id,
               package_price_pkr, commission_rate, commission_pkr)
            VALUES (?, ?, ?, ?, 20, ?)
          `).run(
            referrer.id,
            req.session.userId,
            result.lastInsertRowid,
            selectedPackage.price_pkr,
            commissionPkr
          );

          // Ensure referrer's demo wallet exists
          db.prepare(`
            INSERT INTO wallets (user_id, balance_pkr)
            VALUES (?, 0)
            ON CONFLICT(user_id) DO NOTHING
          `).run(referrer.id);

          // Add commission to demo wallet
          db.prepare(`
            UPDATE wallets
            SET balance_pkr = balance_pkr + ?
            WHERE user_id = ?
          `).run(commissionPkr, referrer.id);

          // Add commission to demo transaction history
          db.prepare(`
            INSERT INTO wallet_transactions
              (user_id, amount_pkr, description)
            VALUES (?, ?, ?)
          `).run(
            referrer.id,
            commissionPkr,
            `Demo referral commission (20%) for package: ${selectedPackage.name}`
          );

          commission = {
            rate: 20,
            amountPkr: commissionPkr,
            status: "demo_only"
          };
        }
      }

      return { package: selectedPackage, commission };
    });

    const result = activateDemo();
    res.json({
      success: true,
      message: "Demo package activated. No payment was taken.",
      ...result
    });
  } catch (error) {
    const clientErrors = [
      "Package not found.",
      "You already activated this demo package."
    ];

    if (clientErrors.includes(error.message)) {
      return res.status(400).json({
        success: false,
        message: error.message
      });
    }

    console.error(error);
    res.status(500).json({
      success: false,
      message: "Could not activate demo package."
    });
  }
});

app.get("/api/my-packages", (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({
      success: false,
      message: "Please login first."
    });
  }

  try {
    const packages = db.prepare(`
      SELECT up.id, p.name, p.price_pkr, up.status, up.activated_at
      FROM user_packages up
      JOIN packages p ON p.id = up.package_id
      WHERE up.user_id = ?
      ORDER BY up.id DESC
    `).all(req.session.userId);

    res.json({ success: true, packages });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: "Could not load your packages."
    });
  }
});



app.listen(PORT, "0.0.0.0", () => {
  console.log("mfaarhyaadm running on port " + PORT);
});
