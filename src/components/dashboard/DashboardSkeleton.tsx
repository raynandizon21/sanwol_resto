import React from 'react';
import { Skeleton } from '../ui/Skeleton';

export const DashboardSkeleton = () => {
  return (
    <div className="flex gap-8 animate-pulse">
      <div className="flex-1 space-y-8">
        <div className="flex gap-6">
          <Skeleton className="h-[96px] flex-1 rounded-2xl" />
          <Skeleton className="h-[96px] flex-1 rounded-2xl" />
          <Skeleton className="h-[96px] flex-1 rounded-2xl" />
        </div>

        <div className="grid grid-cols-3 gap-6">
          <div className="col-span-2 bg-gray-50/50 p-6 rounded-2xl shadow-sm">
            <div className="flex items-center justify-between mb-8">
              <div>
                <Skeleton className="h-5 w-32 mb-2" />
                <Skeleton className="h-9 w-48" />
              </div>
              <div className="flex items-center gap-6">
                <Skeleton className="h-8 w-40" />
              </div>
            </div>
            <div className="h-64 w-full">
              <Skeleton className="h-full w-full rounded-lg" />
            </div>
          </div>

          <div className="bg-gray-50/50 p-6 rounded-2xl shadow-sm">
            <div className="flex items-center justify-between mb-6">
              <Skeleton className="h-5 w-24" />
              <Skeleton className="h-8 w-28" />
            </div>
            <div className="h-48 w-full relative flex items-center justify-center">
                <Skeleton className="h-40 w-40 rounded-full" />
            </div>
            <div className="grid grid-cols-2 gap-y-3 mt-4">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-4 w-20" />
            </div>
          </div>
        </div>

        <div className="bg-gray-50/50 p-6 rounded-2xl shadow-sm">
           <div className="flex items-center justify-between mb-8">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-8 w-56" />
            </div>
            <div className="space-y-4">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
            </div>
        </div>

      </div>

      <div className="w-80 space-y-8">
        <div className="bg-gray-50/50 p-6 rounded-2xl shadow-sm h-full flex flex-col">
            <div className="flex items-center justify-between mb-6">
                <Skeleton className="h-5 w-32" />
                <Skeleton className="h-8 w-24" />
            </div>
            <div className="flex-1 space-y-4">
                <Skeleton className="h-32 w-full" />
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-32 w-full" />
                <Skeleton className="h-16 w-full" />
            </div>
        </div>
      </div>
    </div>
  );
};
