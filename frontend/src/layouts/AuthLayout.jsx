import { Suspense } from 'react';
import { Outlet } from 'react-router-dom';
import { AuthCardSkeleton } from '../components/Skeleton';

export default function AuthLayout() {
  return (
    <div className="auth-layout">
      <Suspense fallback={<AuthCardSkeleton />}>
        <Outlet />
      </Suspense>
    </div>
  );
}
