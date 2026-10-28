
const db = require("./database");

// Yahan apna registered username likho
const username = "maryam";

const result = db.prepare(`
  UPDATE users
  SET role = 'admin'
  WHERE username = ?
`).run(username);

if (result.changes === 1) {
  console.log("Admin role successfully assigned!");
} else {
  console.log("User nahi mila. Username check karo.");
}

db.close();
