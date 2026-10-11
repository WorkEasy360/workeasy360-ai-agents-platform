export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <p className="mb-6 text-center text-lg font-semibold">
          WorkEasy360 <span className="text-brand-600">Agents</span>
        </p>
        {children}
      </div>
    </main>
  );
}
