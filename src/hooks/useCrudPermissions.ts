import { useEffect, useState } from 'react';
import { useUser } from '../context/UserContext';
import type { CrudModuleKey, CrudActionKey } from '../constants/crudMenuItems';

type RoleCrudPermissions = {
  [K in CrudModuleKey]?: {
    create?: boolean;
    update?: boolean;
    delete?: boolean;
  };
};

export function useCrudPermissions() {
  const { user } = useUser();
  const [permissions, setPermissions] = useState<RoleCrudPermissions | null>(null);
  const [loading, setLoading] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      if (!user) {
        setPermissions(null);
        return;
      }

      // In this project, "permissions" field encodes the role:
      // 1 = Administrator, others are role IDs like 2, 3, 14...
      const roleId = user.permissions;
      if (!roleId) {
        setPermissions(null);
        return;
      }

      try {
        setLoading(true);
        const token = localStorage.getItem('token');
        const res = await fetch(`/api/user-management/roles/${roleId}/crud-permissions`, {
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        });
        const json = await res.json();
        if (!res.ok || json?.success === false) {
          throw new Error(json?.message || json?.error || 'Failed to load role permissions');
        }
        if (cancelled) return;
        setPermissions((json.data || json.permissions || {}) as RoleCrudPermissions);
      } catch (err) {
        if (!cancelled) {
          console.error('Failed to load CRUD permissions for current user role', err);
          setPermissions(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();

    return () => {
      cancelled = true;
    };
  }, [user?.permissions, user?.user_id, reloadKey]);

  // Listen for global signal when an admin updates role CRUD permissions
  useEffect(() => {
    const handler = () => {
      setReloadKey((prev) => prev + 1);
    };

    if (typeof window !== 'undefined') {
      window.addEventListener('crud-permissions-updated', handler);
    }

    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('crud-permissions-updated', handler);
      }
    };
  }, []);

  const can = (moduleKey: CrudModuleKey, action: CrudActionKey): boolean => {
    // For now, admin (permissions === 1) bypasses per-role CRUD restrictions
    if (user?.permissions === 1) return true;
    const mod = permissions?.[moduleKey];
    if (!mod) return false;
    return !!mod[action];
  };

  return {
    loading,
    canCreate: (moduleKey: CrudModuleKey) => can(moduleKey, 'create'),
    canUpdate: (moduleKey: CrudModuleKey) => can(moduleKey, 'update'),
    canDelete: (moduleKey: CrudModuleKey) => can(moduleKey, 'delete'),
  };
}

