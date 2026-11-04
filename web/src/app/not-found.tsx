import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-3 px-4 text-center">
      <p className="text-sm font-semibold text-blue-700">404</p>
      <h1 className="text-2xl font-semibold text-slate-900">Page not found</h1>
      <p className="text-sm text-slate-600">The page you’re looking for doesn’t exist or you don’t have access.</p>
      <Link href="/dashboard" className="mt-2 text-sm font-medium text-blue-700 hover:underline">
        Go to dashboard
      </Link>
    </main>
  );
}
