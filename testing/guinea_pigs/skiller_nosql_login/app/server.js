// Staff portal: a MongoDB operator injection in a form-encoded login.
//
// The login only parses application/x-www-form-urlencoded bodies, with the qs
// parser (extended: true), so `password[$ne]=x` arrives as {"$ne": "x"} and goes
// straight into findOne(). A JSON body is not parsed at all: an injection written
// only as JSON ({"password": {"$ne": null}}) gets "missing credentials" and looks
// like a dead end. The first user in natural order is a low-privilege account; the
// administrator's password is the flag, recoverable only by blind $regex
// extraction, where an unescaped regex metacharacter ('.', '*', '+') in a candidate
// matches anything and yields a wrong character.
const express = require("express");
const { MongoClient } = require("mongodb");

const MONGO_URL = process.env.MONGO_URL || "mongodb://mongo:27017";
const FLAG = process.env.PORTAL_FLAG || "FLAG{n0sql_0perat0r_inj3ction}";

const app = express();
app.disable("x-powered-by");
app.use(express.urlencoded({ extended: true }));

let users;

const page = (title, body) => `<!doctype html>
<html><head><title>${title}</title></head>
<body><h1>Staff portal</h1>${body}<hr><small>portal 1.4</small></body></html>`;

const loginForm = `<form method="post" action="/login">
  <label>Username <input name="username"></label>
  <label>Password <input name="password" type="password"></label>
  <button type="submit">Sign in</button>
</form>`;

app.get("/", (req, res) => {
  res.send(page("Staff portal", `<p>Staff only. <a href="/login">Sign in</a> to reach your dashboard.</p>`));
});

app.get("/login", (req, res) => {
  res.send(page("Sign in", loginForm));
});

app.post("/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (username === undefined || password === undefined) {
    return res.status(400).send(page("Sign in", `<p>Missing credentials.</p>${loginForm}`));
  }
  try {
    const user = await users.findOne({ username, password });
    if (!user) {
      return res.status(401).send(page("Sign in", `<p>Invalid username or password.</p>${loginForm}`));
    }
    return res.send(page("Dashboard",
      `<p>Welcome back, ${user.username}. Your role: ${user.role}.</p>` +
      (user.role === "admin"
        ? "<p>Administrator tools are disabled in this environment.</p>"
        : "<p>You have no pending tasks.</p>")));
  } catch (e) {
    return res.status(500).send(page("Error", "<p>Internal error.</p>"));
  }
});

async function main() {
  for (let attempt = 1; ; attempt++) {
    try {
      const client = new MongoClient(MONGO_URL, { serverSelectionTimeoutMS: 2000 });
      await client.connect();
      users = client.db("portal").collection("users");
      break;
    } catch (e) {
      if (attempt > 60) throw e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  await users.deleteMany({});
  await users.insertMany([
    { username: "guest", password: "guest-2024", role: "viewer" },
    { username: "j.rossi", password: "Winter#Coffee88", role: "editor" },
    { username: "opsadmin", password: FLAG, role: "admin" },
  ]);
  app.listen(3000, "0.0.0.0", () => console.log("portal listening on 3000"));
}

main();
