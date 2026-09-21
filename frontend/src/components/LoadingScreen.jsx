import { AppShellSkeleton, AuthCardSkeleton } from './Skeleton';

export default function LoadingScreen({ variant }) {
  if (variant === 'auth') {
    return (
      <div className="auth-layout">
        <AuthCardSkeleton />
      </div>
    );
  }
  return <AppShellSkeleton />;
}