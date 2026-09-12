# Cooperative Gig Services Platform — SIH 2026 PS 89

A cooperative-owned gig services platform for household & community services. Unlike conventional gig platforms (like Urban Company), this platform emphasizes **fair work allocation**, **worker welfare**, **transparent pricing**, **verified skilled workers**, and **AI-assisted matching & demand forecasting**.

---

## 🧱 Tech Stack

### Frontend
- **React.js + Vite** (JavaScript)
- **React Router** — routing
- **Axios** — API calls
- **Tailwind CSS** — styling
- **Leaflet + OpenStreetMap** — maps & location
- **Recharts** — analytics charts
- **React Hook Form** — forms

### Backend
- **Node.js + Express.js**
- **MongoDB Atlas + Mongoose** (cloud MongoDB)
- **JWT** — authentication
- **bcryptjs** — password hashing
- **Multer** — file/image uploads
- **Socket.IO** — real-time notifications

---

## 🔧 Prerequisites

1. **Node.js** (v18+)
   - Download from https://nodejs.org
2. **MongoDB Atlas** (cloud database — no local MongoDB needed)
   - Create a free account and a free M0 cluster at https://www.mongodb.com/cloud/atlas
   - **Database Access** → add a DB user (username + password)
   - **Network Access** → allow your IP (or `0.0.0.0/0` for demos)
   - **Connect → Drivers** → copy your `mongodb+srv://...` connection string

---

## 🚀 Setup & Run

### 1. MongoDB Atlas (cloud)

No local MongoDB installation is required. The backend connects directly to your Atlas cluster using the `MONGO_URI` in `backend/.env`. You only need:

- a free M0 cluster created (see Prerequisites above), and
- your cluster connection string pasted into `MONGO_URI` (see Environment Variables below).

The app uses the `cooperative_gig_platform` database inside your cluster. You can seed it once with `npm run seed` (kept optional below because it only needs to run on first setup).

### 2. Backend

```bash
cd backend
npm install
# Create .env file (copy from .env.example):
cp .env.example .env
# Seed database (optional, recommended for demo):
npm run seed
# Start backend
npm run dev
```

Backend runs at `http://localhost:5001`

### 3. Frontend

```bash
cd frontend
npm install
npm run dev
```

Frontend runs at `http://localhost:5173`

---

## 🔑 Environment Variables

Create `backend/.env` based on `backend/.env.example`:

```
PORT=5001
# MongoDB Atlas connection string (from Connect → Drivers in your Atlas console).
# Replace <db_user>, <db_password> and <cluster-name> with your values.
MONGO_URI=mongodb+srv://<db_user>:<db_password>@<cluster-name>.mongodb.net/cooperative_gig_platform?retryWrites=true&w=majority
JWT_SECRET=your_super_secret_key
JWT_EXPIRES_IN=7d
```

---

## 💻 Demo Login Credentials (after seeding)

| Role    | Email                  | Password |
|---------|------------------------|----------|
| Admin   | admin@coop.in          | Admin@123 |
| Customer| customer1@test.com     | Pass@123  |
| Worker  | worker1@test.com       | Pass@123  |

---

## 🗂 Project Structure

```
cooperative-gig-platform/
│
├── frontend/                  # React/Vite app
│   └── src/
│       ├── components/        # Reusable UI components
│       ├── pages/
│       │   ├── auth/          # Login, Register, Forgot/Reset Password
│       │   ├── customer/      # Customer app
│       │   ├── worker/        # Worker app
│       │   ├── admin/         # Cooperative admin dashboard
│       │   └── public/        # Landing, about, etc.
│       ├── layouts/           # Shared layout components
│       ├── hooks/             # Custom React hooks
│       ├── services/          # API call layer (axios)
│       ├── context/           # Auth & internationalization context
│       ├── utils/             # Helper utilities
│       └── App.jsx
│
├── backend/                   # Express API
│   └── src/
│       ├── config/            # DB connection, env
│       ├── models/            # Mongoose schemas
│       ├── controllers/
│       │   ├── auth/          # Auth controller
│       │   ├── customer/      # Customer controllers
│       │   ├── worker/        # Worker controllers
│       │   ├── admin/         # Admin controllers
│       │   └── shared/        # Services, bookings, payments
│       ├── routes/            # Express routes
│       ├── middleware/        # auth, role, error, upload
│       ├── services/          # Business logic (matching, ai, payment)
│       ├── utils/             # Helpers, seed script
│       └── server.js
│
├── README.md
└── .gitignore
```

---

## ✨ Key Features

- **Role-based access** — Customer / Worker / Admin (Cooperative)
- **Fair worker matching** — scoring based on skill, distance, availability, rating, experience, **and workload fairness**
- **Transparent pricing** — full breakdown (labour, materials, cooperative contribution, fees)
- **Payments (Razorpay TEST + MOCK fallback)** — server-verified orders, per-booking price breakdown, automatic invoices, worker wallet with held earnings (released on customer confirmation), withdrawal requests, and an admin payout lifecycle (PENDING → PROCESSING → COMPLETED/FAILED)
- **Invoices** — generated automatically after completion
- **Ratings & reviews** — bi-directional (customer ↔ worker), single review per booking
- **Complaint/dispute management**
- **Worker welfare module** — insurance, schemes, training, benefits
- **Training & certification programs** — with enrollment tracking
- **Admin analytics** — Recharts dashboards
- **Demand heatmap** — Leaflet geographic visualization
- **AI demand forecasting** — statistical/mock predictions ready for Python ML
- **AI workforce allocation** — identifies shortages, overloaded/underutilized workers
- **Voice input** — Web Speech API (replaceable with multilingual AI later)
- **Multilingual** — i18n English + Hindi (React i18next)
- **Real-time notifications** — Socket.IO

---

## 🗺 Demo Scenario

1. **Customer** logs in → selects Plumbing → describes leaking pipe → uploads image → location → selects emergency → request
2. Matching engine finds suitable (and fairly allocated) workers
3. **Worker** accepts → navigates → starts job → uploads before/after images → completes
4. Customer confirms → **payment** → **invoice** → **rating**
5. **Admin** monitors bookings, allocation, demand map, AI predictions, workload, revenue, welfare

---

## 📜 License

Internal prototype for SIH 2026 — Problem Statement 89.
