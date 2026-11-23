# WedPlan Server — Backend API

Backend REST API for **WedPlan — Wedding Planning Platform**, powered by Node.js, Express 5, MongoDB Atlas, Better Auth integration, and Stripe Checkout.

---

## 🛠️ Tech Stack & Architecture
- **Framework**: Node.js & Express.js 5 (ES Modules)
- **Database**: MongoDB Atlas via official Node.js Driver
- **Authentication**: JWT & Session verification interoperable with Better Auth
- **Payment Processing**: Stripe Checkout API & Cryptographically Verified Webhooks
- **Security**: CORS, role-based middleware (`verifyAdmin`, `verifyVendor`, `verifyCustomer`), resource ownership validation

---

## 🔑 Environment Variables
Create a `.env` file in the root of `wedplan_server`:

```env
PORT=8000
MONGODB_URI=mongodb+srv://<username>:<password>@cluster.mongodb.net/wedplan?retryWrites=true&w=majority
CLIENT_URL=http://localhost:3000

# Stripe Secret & Webhook Keys (Test Mode)
STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

---

## 🚀 Running the Server Locally

```bash
# 1. Install dependencies
npm install

# 2. Run in development mode (with auto-reload)
npm run dev

# 3. Run in production mode
npm start
```
The server will bind to `http://localhost:8000`.

---

## 📡 API Endpoint Overview

### 1. Webhook & System
- `POST /stripe-webhook`: Raw body listener for signed `checkout.session.completed` events
- `GET /`: Health check endpoint

### 2. Services
- `POST /services`: Create a new wedding service (Vendor only, subject to free-plan limits)
- `GET /featured`: Fetch active spotlight services for the homepage
- `GET /services`: Dynamic directory query (supports `search`, `category`, `location`, `status`, `sort`)
- `GET /services/:id`: Fetch single service details
- `PUT /services/:id`: Update vendor's own listing
- `PUT /services/:id/status`: Admin moderation (Approve / Decline)
- `DELETE /services/:id`: Delete service (Admin or owning vendor)

### 3. Bookings
- `POST /bookings`: Submit a customer booking inquiry
- `GET /bookings`: Fetch customer's personal booking requests
- `GET /bookings/vendor`: Fetch incoming bookings for a vendor's services
- `PUT /bookings/:id/status`: Accept or Reject pending booking (Vendor only)
- `DELETE /bookings/:id`: Cancel pending booking request (Customer only)

### 4. Admin Management & Auditing
- `GET /admin/stats`: Real-time platform metrics (Users, Vendors, Customers, Services, Transactions)
- `GET /users`: Filterable user directory
- `PUT /users/:id/block`: Block or unblock a registered user
- `GET /transactions`: Stripe payment and subscription audit logs

### 5. Payments & Subscriptions
- `POST /create-checkout-session`: Generate Stripe checkout URL for Premium membership
- `POST /verify-payment`: Confirm payment status and activate 90-day Premium plan

---

## 🛡️ License
Assignment 9 (Category: 004) - WedPlan Platform.
