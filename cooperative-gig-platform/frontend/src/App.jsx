import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { AuthProvider, useAuth } from './context/AuthContext';

// Auth pages
import Login from './pages/auth/Login';
import RoleLogin from './pages/auth/RoleLogin';
import Register from './pages/auth/Register';
import ForgotPassword from './pages/auth/ForgotPassword';

// Layouts
import CustomerLayout from './layouts/CustomerLayout';
import WorkerLayout from './layouts/WorkerLayout';
import AdminLayout from './layouts/AdminLayout';

// Customer pages
import CustomerDashboard from './pages/customer/CustomerDashboard';
import Services from './pages/customer/Services';
import CreateRequest from './pages/customer/CreateRequest';
import MyComplaints from './pages/customer/MyComplaints';
import MyBookings from './pages/customer/MyBookings';
import BookingDetails from './pages/customer/BookingDetails';
import Notifications from './pages/Notifications';
import { NotificationProvider } from './context/NotificationContext';
import Profile from './pages/customer/Profile';
import PaymentHistory from './pages/customer/PaymentHistory';

// Worker pages
import WorkerDashboard from './pages/worker/WorkerDashboard';
import WorkerProfile from './pages/worker/WorkerProfile';
import JobRequests from './pages/worker/JobRequests';
import ActiveJobs from './pages/worker/ActiveJobs';
import JobHistory from './pages/worker/JobHistory';
import Earnings from './pages/worker/Earnings';
import Welfare from './pages/worker/Welfare';
import Collaborations from './pages/worker/collaborator/Collaborations';
import WorkerComplaints from './pages/worker/WorkerComplaints';

// Admin pages
import AdminDashboard from './pages/admin/AdminDashboard';
import AdminWorkers from './pages/admin/AdminWorkers';
import AdminBookings from './pages/admin/AdminBookings';
import AdminComplaints from './pages/admin/AdminComplaints';
import AdminAnalytics from './pages/admin/AdminAnalytics';
import AdminDemand from './pages/admin/AdminDemand';
import AdminForecast from './pages/admin/AdminForecast';
import AdminWelfare from './pages/admin/AdminWelfare';
import AdminSettings from './pages/admin/AdminSettings';
import AdminReliability from './pages/admin/AdminReliability';
import AdminPayments from './pages/admin/AdminPayments';
import AdminSuspensions from './pages/admin/AdminSuspensions';

function ProtectedRoute({ children, allowedRoles }) {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-brand-600"></div>
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  if (allowedRoles && !allowedRoles.includes(user.role)) {
    const redirect = `/${user.role === 'worker' ? 'worker' : user.role === 'admin' ? 'admin' : 'customer'}`;
    return <Navigate to={redirect} replace />;
  }
  return children;
}

function PublicRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="flex items-center justify-center h-screen"><div className="animate-spin rounded-full h-12 w-12 border-b-2 border-brand-600"></div></div>;
  if (user) {
    return <Navigate to={`/${user.role === 'worker' ? 'worker' : user.role === 'admin' ? 'admin' : 'customer'}`} replace />;
  }
  return children;
}

function Landing() {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (user) return <Navigate to={`/${user.role === 'worker' ? 'worker' : user.role === 'admin' ? 'admin' : 'customer'}`} replace />;
  return <Navigate to="/login" replace />;
}

export default function App() {
  return (
    <AuthProvider>
      <NotificationProvider>
        <BrowserRouter>
        <Toaster position="top-right" duration={3000} />
        <Routes>
          <Route path="/" element={<Landing />} />

          {/* Public routes */}
          <Route path="/login" element={<PublicRoute><Login /></PublicRoute>} />
          <Route path="/customer/login" element={<PublicRoute><RoleLogin mode="customer" /></PublicRoute>} />
          <Route path="/worker/login" element={<PublicRoute><RoleLogin mode="worker" /></PublicRoute>} />
          <Route path="/admin/login" element={<PublicRoute><RoleLogin mode="admin" /></PublicRoute>} />
          <Route path="/register" element={<PublicRoute><Register /></PublicRoute>} />
          <Route path="/forgot-password" element={<PublicRoute><ForgotPassword /></PublicRoute>} />

          {/* Customer routes */}
          <Route path="/customer" element={<ProtectedRoute allowedRoles={['customer']}><CustomerLayout /></ProtectedRoute>}>
            <Route index element={<CustomerDashboard />} />
            <Route path="services" element={<Services />} />
            <Route path="services/request" element={<CreateRequest />} />
            <Route path="services/request/:serviceId" element={<CreateRequest />} />
            <Route path="bookings" element={<MyBookings />} />
            <Route path="bookings/:id" element={<BookingDetails />} />
            <Route path="payments" element={<PaymentHistory />} />
            <Route path="complaints" element={<MyComplaints />} />
            <Route path="notifications" element={<Notifications />} />
            <Route path="profile" element={<Profile />} />
          </Route>

          {/* Worker routes */}
          <Route path="/worker" element={<ProtectedRoute allowedRoles={['worker']}><WorkerLayout /></ProtectedRoute>}>
            <Route index element={<WorkerDashboard />} />
            <Route path="profile" element={<WorkerProfile />} />
            <Route path="jobs" element={<JobRequests />} />
            <Route path="active" element={<ActiveJobs />} />
            <Route path="history" element={<JobHistory />} />
            <Route path="earnings" element={<Earnings />} />
            <Route path="welfare" element={<Welfare />} />
            <Route path="collaborations" element={<Collaborations />} />
            <Route path="complaints" element={<WorkerComplaints />} />
            <Route path="notifications" element={<Notifications />} />
          </Route>

          {/* Admin routes */}
          <Route path="/admin" element={<ProtectedRoute allowedRoles={['admin']}><AdminLayout /></ProtectedRoute>}>
            <Route index element={<AdminDashboard />} />
            <Route path="workers" element={<AdminWorkers />} />
            <Route path="bookings" element={<AdminBookings />} />
            <Route path="complaints" element={<AdminComplaints />} />
            <Route path="notifications" element={<Notifications />} />
            <Route path="analytics" element={<AdminAnalytics />} />
            <Route path="demand" element={<AdminDemand />} />
            <Route path="forecast" element={<AdminForecast />} />
            <Route path="welfare" element={<AdminWelfare />} />
            <Route path="reliability" element={<AdminReliability />} />
            <Route path="suspensions" element={<AdminSuspensions />} />
            <Route path="payments" element={<AdminPayments />} />
            <Route path="settings" element={<AdminSettings />} />
          </Route>

          <Route path="*" element={<div className="flex flex-col items-center justify-center h-screen"><h1 className="text-4xl font-bold text-gray-300">404</h1><p className="text-gray-500">Page not found</p></div>} />
        </Routes>
        </BrowserRouter>
      </NotificationProvider>
    </AuthProvider>
  );
}
