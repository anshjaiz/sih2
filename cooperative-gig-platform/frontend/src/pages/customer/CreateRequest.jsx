import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../../services/api';
import toast from 'react-hot-toast';
import LocationPicker from '../../components/LocationPicker';

const EMERGENCY_TYPES = [
  { value: 'Electrical emergency', key: 'electrical' },
  { value: 'Water leakage', key: 'waterLeakage' },
  { value: 'Pipe burst', key: 'pipeBurst' },
  { value: 'Lockout', key: 'lockout' },
  { value: 'Urgent caregiving', key: 'urgentCaregiving' },
  { value: 'Other', key: 'other' },
];

const TIME_SLOTS = [
  { value: 'Morning', labelKey: 'morning' },
  { value: 'Afternoon', labelKey: 'afternoon' },
  { value: 'Evening', labelKey: 'evening' },
  { value: 'Flexible', labelKey: 'flexible' },
];

export default function CreateRequest() {
  const { serviceId } = useParams();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [service, setService] = useState(null);
  const [form, setForm] = useState({
    description: '',
    address: '',
    city: 'Hyderabad',
    requestedDate: '',
    timeSlot: 'Morning',
    isEmergency: false,
    emergencyType: '',
    lat: '17.385',
    lng: '78.487',
  });
  const [loading, setLoading] = useState(false);
  const [cancellationInfo, setCancellationInfo] = useState(null);

  useEffect(() => {
    if (!serviceId) return;
    const load = async () => {
      try {
        const res = await api.get(`/services/${serviceId}`);
        setService(res.data);
      } catch (e) {
        toast.error(t('toast.serviceNotFound'));
      }
    };
    load();
  }, [serviceId, t]);

  useEffect(() => {
    const loadProfile = async () => {
      try {
        const res = await api.get('/customers/profile');
        const p = res.data;
        if (p) {
          setCancellationInfo({
            outstandingCancellationBalance: p.outstandingCancellationBalance || 0,
            suspensionStatus: p.suspensionStatus || 'ACTIVE',
            suspendedUntil: p.suspendedUntil || null,
            suspensionReason: p.suspensionReason || '',
          });
          setForm((f) => ({
            ...f,
            address: f.address || p.address || '',
            city: f.city || p.city || 'Hyderabad',
            lat: p.location?.coordinates?.[1] ?? '17.385',
            lng: p.location?.coordinates?.[0] ?? '78.487',
          }));
        }
      } catch {
        /* ignore */
      }
    };
    loadProfile();
  }, []);

  const isSuspended =
    cancellationInfo?.suspensionStatus === 'SUSPENDED' &&
    (!cancellationInfo.suspendedUntil || new Date(cancellationInfo.suspendedUntil).getTime() > Date.now());

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setForm({ ...form, [name]: type === 'checkbox' ? checked : value });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!serviceId) { toast.error(t('create.selectServiceFirst')); return; }
    if (isSuspended) {
      toast.error(t('cancel.suspended', 'Your account is temporarily suspended due to repeated cancellations.'));
      return;
    }
    setLoading(true);
    try {
      const payload = {
        serviceId,
        description: form.description,
        address: form.address,
        location: {
          type: 'Point',
          coordinates: [parseFloat(form.lng) || 78.487, parseFloat(form.lat) || 17.385],
        },
        area: '',
        city: form.city,
        requestedDate: form.requestedDate || new Date(),
        timeSlot: form.timeSlot,
        isEmergency: form.isEmergency,
        emergencyType: form.emergencyType,
      };

      const res = await api.post('/customers/bookings', payload);

      if (form.address && form.city) {
        await api.put('/customers/profile', {
          address: form.address,
          city: form.city,
          location: payload.location,
        }).catch(() => {});
      }

      toast.success(t('create.successToast'));
      navigate(`/customer/bookings/${res.data.booking._id}`);
    } catch (err) {
      toast.error(err.message || t('toast.createFailed'));
    }
    setLoading(false);
  };

  const locationValue = { address: form.address, city: form.city, lat: form.lat, lng: form.lng };

  const getSlotLabel = (slot) => {
    const match = TIME_SLOTS.find((s) => slot.startsWith(s.value));
    return match ? t(`create.timeSlots.${match.labelKey}`, slot) : slot;
  };

  return (
    <div className="max-w-2xl mx-auto">
      <h2 className="text-xl font-bold text-gray-900 mb-6">{t('create.title')}</h2>

      {service && (
        <div className="card mb-6">
          <h3 className="font-semibold">{service.name}</h3>
          <p className="text-sm text-gray-500">{service.category} • ₹{service.basePrice} {t('common.base')}</p>
        </div>
      )}

      {!serviceId && (
        <div className="card mb-6">
          <p className="text-gray-500">{t('create.selectServiceFirst')}</p>
        </div>
      )}

      {isSuspended && (
        <div className="card mb-6 border-red-200 bg-red-50">
          <h3 className="font-semibold text-red-700">{t('cancel.suspended', 'Your account is temporarily suspended')}</h3>
          <p className="text-sm text-red-600 mt-1">
            {cancellationInfo?.suspendedUntil
              ? t('cancel.suspendedUntil', 'You cannot create new bookings until {{date}}.', {
                  date: new Date(cancellationInfo.suspendedUntil).toLocaleDateString(),
                })
              : t('cancel.suspendedNoDate', 'You cannot create new bookings while suspended.')}
          </p>
          {cancellationInfo?.suspensionReason && (
            <p className="text-xs text-red-500 mt-1">{cancellationInfo.suspensionReason}</p>
          )}
          <p className="text-xs text-red-500 mt-2">
            {t('cancel.suspendedHint', 'Automatic suspension follows repeated eligible cancellations. Contact support if this is a mistake.')}
          </p>
        </div>
      )}

      {!isSuspended && cancellationInfo?.outstandingCancellationBalance > 0 && (
        <div className="card mb-6 border-amber-200 bg-amber-50">
          <h3 className="font-semibold text-amber-800">
            {t('cancel.outstandingBalance', 'Outstanding cancellation balance')}
          </h3>
          <p className="text-sm text-amber-700 mt-1">
            {t('cancel.outstandingMsg', 'You have ₹{{amount}} pending from a cancelled booking. It will be collected with this booking\'s payment.', {
              amount: cancellationInfo.outstandingCancellationBalance,
            })}
          </p>
        </div>
      )}

      <form onSubmit={handleSubmit} className="card space-y-5">
        <div>
          <label className="label-text">{t('create.describeProblem')}</label>
          <textarea
            name="description"
            className="input-field"
            rows={4}
            placeholder={t('create.problemPlaceholder')}
            value={form.description}
            onChange={handleChange}
          />
        </div>

        <div className="flex items-center gap-3 p-3 bg-orange-50 rounded-lg border border-orange-200">
          <input
            type="checkbox"
            name="isEmergency"
            checked={form.isEmergency}
            onChange={handleChange}
            className="w-4 h-4 text-orange-600 rounded"
          />
          <div>
            <p className="font-medium text-orange-800 text-sm">{t('create.isEmergency')}</p>
            <p className="text-xs text-orange-600">{t('create.emergencyHint')}</p>
          </div>
        </div>

        {form.isEmergency && (
          <div>
            <label className="label-text">{t('create.emergencyType')}</label>
            <select name="emergencyType" className="input-field" value={form.emergencyType} onChange={handleChange}>
              <option value="">{t('create.selectType')}</option>
              {EMERGENCY_TYPES.map((et) => (
                <option key={et.value} value={et.value}>{t(`create.emergencyOptions.${et.key}`)}</option>
              ))}
            </select>
          </div>
        )}

        <div className="space-y-1">
          <label className="label-text">{t('create.address')}</label>
          <LocationPicker
            value={locationValue}
            onChange={(v) => setForm({ ...form, address: v.address || '', city: v.city || '', lat: String(v.lat), lng: String(v.lng) })}
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label-text">{t('create.preferredDate')}</label>
            <input
              type="date"
              name="requestedDate"
              className="input-field"
              value={form.requestedDate}
              onChange={handleChange}
              required
            />
          </div>
          <div>
            <label className="label-text">{t('create.timeSlot')}</label>
            <select name="timeSlot" className="input-field" value={form.timeSlot} onChange={handleChange}>
              {TIME_SLOTS.map((s) => (
                <option key={s.value} value={s.value}>{getSlotLabel(s.value)}</option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <p className="font-semibold text-gray-900">{t('create.serviceCharge')}</p>
            <p className="font-semibold text-brand-600">₹{service?.basePrice || 0}</p>
          </div>
          <div className="flex items-center justify-between mb-1">
            <p className="text-sm text-gray-600">{t('create.platformFee')}</p>
            <p className="text-sm text-gray-600">{t('common.included')}</p>
          </div>
          <div className="flex items-center justify-between border-t border-gray-100 pt-2">
            <p className="font-semibold text-gray-900">{t('common.total')}</p>
            <p className="font-bold text-brand-600">₹{service?.basePrice || 0}</p>
          </div>
          <p className="text-xs text-gray-400 mt-2">
            {t('create.materialNote')}
          </p>
        </div>

        <button type="submit" disabled={loading || !serviceId || isSuspended} className="btn-primary w-full">
          {loading ? t('create.creating') : t('create.submitRequest')}
        </button>
      </form>
    </div>
  );
}