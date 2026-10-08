# 🍽️ Restaurant Admin Management System

A comprehensive restaurant management system built with Node.js, Express, and MySQL. This system provides an admin dashboard for managing restaurant operations including menu items, categories, tables, and user accounts.

## ✨ Features

- **Menu Management** - Create, update, and manage restaurant menu items
- **Category Management** - Organize menu items by categories
- **Table Management** - Manage restaurant table assignments
- **User Management** - Admin user accounts and role management
- **Multi-language Support** - Support for English, Japanese, Korean, and Chinese
- **Auto Translation** - Automatic translation of menu names and categories using Google Cloud Translation API
- **Dashboard** - Comprehensive admin dashboard with analytics
- **API Endpoints** - RESTful API for external integrations
- **Authentication** - Secure user authentication and session management

## 🛠️ Tech Stack

- **Backend**: Node.js, Express.js
- **Database**: MySQL
- **Template Engine**: EJS
- **Authentication**: Passport.js, JWT
- **File Upload**: Multer
- **Other**: ExcelJS, Telegram Bot API, i18n

## 📋 Prerequisites

- Node.js (v14 or higher)
- MySQL (v5.7 or higher)
- npm or yarn

## 🚀 Installation

1. Clone the repository:
```bash
git clone https://github.com/Jegel-sys/restaurantAdmin.git
cd restaurantAdmin
```

2. Install dependencies:
```bash
npm install
```

3. Configure environment variables:
Create a `.env` file in the root directory:
```env
DB_HOST=localhost
DB_USER=your_username
DB_PASSWORD=your_password
DB_NAME=restaurant_db
SESSION_SECRET=your_secret_key
JWT_SECRET=your_jwt_secret

# Google Cloud Translation API (Optional - for auto-translation of menu names and categories)
# Option 1: Path to service account JSON key file
GOOGLE_APPLICATION_CREDENTIALS=/path/to/your/service-account-key.json

# Option 2: Project ID (if using default credentials)
GOOGLE_CLOUD_PROJECT_ID=your-project-id
```

**Note:** To enable auto-translation for menu names and categories, see the detailed setup guide: [GOOGLE_TRANSLATION_SETUP.md](./GOOGLE_TRANSLATION_SETUP.md)

**Quick Setup (API Key method - simplest):**
1. Enable Cloud Translation API in Google Cloud Console
2. Create an API key in "APIs & Services" > "Credentials"
3. Add to `.env`: `GOOGLE_TRANSLATE_API_KEY=your-api-key-here`

**Alternative (Service Account - recommended for production):**
1. Create a service account and download JSON key file
2. Add to `.env`: `GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account-key.json`

The API endpoints `/api/menu` and `/api/categories` will automatically translate Korean text to the requested language using the `lang` or `language` query parameter (e.g., `?lang=en`, `?lang=ja`, `?lang=zh`)

4. Set up the database:
Import the SQL schema file from the `sql/` directory into your MySQL database.

**Optional – User Management (restoadmin):** To show email/avatar and role descriptions on the User & Access page, run the migration:
`scripts/migrations/2026-02-06-user-management-tables.sql`  
This adds `user_info.EMAIL`, `user_info.AVATAR_URL`, and `user_role.DESCRIPTION`, `user_role.PERMISSIONS`. The API works without it (uses username as email, default role labels).

5. Start the application:
```bash
# Development mode
npm run dev

# Production mode
npm start
```

## 📁 Project Structure

```
restaurantAdmin/
├── config/          # Configuration files
├── controllers/     # Business logic controllers
├── models/          # Database models
├── routes/          # Route definitions
├── views/           # EJS templates
├── public/          # Static assets
├── middleware/      # Custom middleware
├── utils/           # Utility functions
└── locales/         # Translation files
```

For detailed file structure, see [FILE_STRUCTURE.md](./FILE_STRUCTURE.md)

## 📚 API Documentation

For API endpoints and usage, see [API_DOCUMENTATION.md](./API_DOCUMENTATION.md)

## 🔐 Security Features

- Password hashing with Argon2
- Session management with Redis
- CSRF protection
- Rate limiting
- Helmet.js for security headers

## 🌐 Supported Languages

- English (en)
- Japanese (ja)
- Korean (ko)
- Chinese (zh)

## 📝 License

MIT License

## 👥 Author

Jegel-sys

## 📧 Contact

For questions or support, please contact: jeljelcabuso@gmail.com
