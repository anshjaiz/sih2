import axios from 'axios';

const API_BASE = import.meta.env.VITE_API_URL || '';

const api = axios.create({
  baseURL: `${API_BASE}/api`,
  headers: {
    'Content-Type': 'application/json',
  },
  timeout: 90000,
});

// Request interceptor: attach token
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  // Let the browser set multipart boundaries for file uploads
  if (config.data instanceof FormData) {
    delete config.headers['Content-Type'];
  }
  return config;
});

// Response interceptor: handle errors
api.interceptors.response.use(
  (response) => {
    const data = response.data;
    if (typeof data === 'string' || data === null || data === undefined) {
      // A non-JSON body means the request did NOT reach the Express API
      // (e.g. a static host / reverse proxy returned an HTML page instead).
      return Promise.reject({
        status: response.status,
        message: 'The server returned a response that is not the API. Check that the backend is running and VITE_API_URL is set correctly.',
        data,
      });
    }
    return data;
  },
  (error) => {
    if (error.response) {
      const { status, data } = error.response;
      const isLogin = error.config?.url?.includes('/auth/login');
      if (status === 401 && !isLogin) {
        // Token invalid/expired: clear auth. Never hijack the login request
        // itself — a failed login must surface its real error message instead.
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        window.location.href = '/login?expired=1';
      }
      let message;
      if (typeof data === 'string') {
        message =
          status >= 500
            ? `The server could not be reached (HTTP ${status}). Check that the backend is running and VITE_API_URL is correct.`
            : `The API was not found at this address (HTTP ${status}). Check the API URL / proxy setup.`;
      } else {
        message = data?.message || 'An error occurred';
      }
      return Promise.reject({ status, message, data });
    }
    return Promise.reject({ status: 0, message: 'Network error. Please check your connection.' });
  }
);

export default api;
