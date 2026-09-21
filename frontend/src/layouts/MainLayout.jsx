import { useState, Suspense } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from '../components/Sidebar';
import { FeaturePageSkeleton } from '../components/Skeleton';

export default function MainLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const location = useLocation();

  return (
    <div className="main-layout">
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} currentPath={location.pathname} />
      <div className="main-area">
        <Suspense fallback={<FeaturePageSkeleton />}>
          <Outlet context={{ onMenuClick: () => setSidebarOpen(true) }} />
        </Suspense>
      </div>
    </div>
  );
}
