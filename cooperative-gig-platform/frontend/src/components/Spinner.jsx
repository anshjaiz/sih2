export default function Spinner({ size = 'md', label = null }) {
  const sizeClass = size === 'sm' ? 'h-4 w-4 border-2' : size === 'lg' ? 'h-10 w-10 border-4' : 'h-6 w-6 border-2';

  return (
    <div className="flex flex-col items-center justify-center gap-3 py-10" role="status" aria-live="polite">
      <span
        className={`inline-block animate-spin rounded-full border-[#e3e5dc] border-t-[#1d5a2f] ${sizeClass}`}
      />
      {label && <span className="text-sm text-gray-500">{label}</span>}
    </div>
  );
}
