import React, { createContext, useContext, useState, ReactNode, useCallback, useMemo } from 'react';

type User = {
    user_id: string;
    username: string;
    firstname: string;
    lastname: string;
    permissions: number;
    branch_id: string | null;
    branch_name?: string | null;
    branch_code?: string | null;
    avatar?: string;
};

type UpdateResult = {
    success: boolean;
    message: string;
};

type UserContextType = {
    user: User | null;
    isLoggedIn: boolean;
    login: (userData: User, token: string) => void;
    syncSessionUser: (userData: User) => void;
    logout: () => void;
    updateUser: (updates: Partial<User>) => Promise<UpdateResult>;
};

const UserContext = createContext<UserContextType | undefined>(undefined);

export const UserProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
    const [user, setUser] = useState<User | null>(() => {
        const savedUser = localStorage.getItem('user');
        return savedUser ? JSON.parse(savedUser) : null;
    });

    const [isLoggedIn, setIsLoggedIn] = useState<boolean>(() => {
        return !!localStorage.getItem('token');
    });

    const login = useCallback((userData: User, token: string) => {
        setUser(userData);
        setIsLoggedIn(true);
        localStorage.setItem('user', JSON.stringify(userData));
        localStorage.setItem('token', token);
        // Prevent branch selection leaking across accounts (admin -> manager, etc.)
        // Branch context should come from the logged-in user/session, not a previous user.
        localStorage.removeItem('lastSelectedBranchId');
        localStorage.removeItem('lastSelectedBranchName');
    }, []);

    const syncSessionUser = useCallback((userData: User) => {
        setUser(userData);
        setIsLoggedIn(true);
        localStorage.setItem('user', JSON.stringify(userData));
    }, []);

    const logout = useCallback(() => {
        setUser(null);
        setIsLoggedIn(false);
        localStorage.removeItem('user');
        localStorage.removeItem('token');
        localStorage.removeItem('lastSelectedBranchId');
        localStorage.removeItem('lastSelectedBranchName');

        if (typeof window !== 'undefined') {
            // Fully reload app on logout so that
            // any branch filters or URL state are reset.
            window.location.replace('/login');
        }
    }, []);

    const updateUser = useCallback(async (updates: Partial<User>): Promise<UpdateResult> => {
        if (!user) return { success: false, message: 'No user logged in' };

        const token = localStorage.getItem('token');
        if (!token) return { success: false, message: 'No auth token found' };

        try {
            const res = await fetch('/user/profile', {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`,
                },
                body: JSON.stringify({
                    firstname: updates.firstname,
                    lastname: updates.lastname,
                    username: updates.username,
                }),
            });

            const data = await res.json();

            if (!res.ok || !data.success) {
                return { success: false, message: data.message || data.error || 'Failed to update profile' };
            }

            // Update local state with the server-confirmed data
            const updatedUser: User = {
                ...user,
                firstname: updates.firstname ?? user.firstname,
                lastname: updates.lastname ?? user.lastname,
                username: updates.username ?? user.username,
            };
            setUser(updatedUser);
            localStorage.setItem('user', JSON.stringify(updatedUser));

            return { success: true, message: data.message || 'Profile updated successfully' };
        } catch (error: any) {
            console.error('Error updating profile:', error);
            return { success: false, message: 'Network error. Please try again.' };
        }
    }, [user]);

    const contextValue = useMemo(
        () => ({ user, isLoggedIn, login, syncSessionUser, logout, updateUser }),
        [user, isLoggedIn, login, syncSessionUser, logout, updateUser]
    );

    return (
        <UserContext.Provider value={contextValue}>
            {children}
        </UserContext.Provider>
    );
};

export const useUser = () => {
    const context = useContext(UserContext);
    if (context === undefined) {
        throw new Error('useUser must be used within a UserProvider');
    }
    return context;
};
