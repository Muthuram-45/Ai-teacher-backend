const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'server.js');
let content = fs.readFileSync(filePath, 'utf8');

const targetRegex = /const isProduction = process\.env\.NODE_ENV === "production";[\s\S]*?app\.use\(cors\(corsOptions\)\);/m;

const replacement = `const isProduction = process.env.NODE_ENV === "production";
let corsOrigin;

if (process.env.FRONTEND_URL) {
  const allowed = process.env.FRONTEND_URL.split(",")
    .map(u => u.trim().replace(/\\/+$/, ""))
    .filter(Boolean);

  corsOrigin = function (origin, callback) {
    if (!origin) return callback(null, true);
    const cleanOrigin = origin.trim().replace(/\\/+$/, "");

    if (
      allowed.includes(cleanOrigin) ||
      allowed.includes("*") ||
      cleanOrigin.endsWith(".vercel.app") ||
      cleanOrigin.includes("localhost")
    ) {
      return callback(null, true);
    }

    console.warn(\`[CORS] Rejected origin: \${origin}\`);
    return callback(null, false);
  };
} else {
  corsOrigin = true;
}

const corsOptions = {
  origin: corsOrigin,
  credentials: true,
  methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"]
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));`;

if (targetRegex.test(content)) {
  content = content.replace(targetRegex, replacement);
  fs.writeFileSync(filePath, content, 'utf8');
  console.log("Successfully patched CORS in server.js!");
} else {
  console.error("Target regex did not match!");
}

