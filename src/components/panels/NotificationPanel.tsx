import React from 'react';
import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Bell, ShoppingBag, User, CheckCircle, Info } from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export type Notification = {
  id: string;
  title: string;
  message: string;
  time: string;
  type: 'order' | 'user' | 'system' | 'success';
  unread: boolean;
};

export const mockNotifications: Notification[] = [
  {
    id: '1',
    title: 'New Order Received',
    message: 'Table 5 has placed a new order for 3 items.',
    time: '2 mins ago',
    type: 'order',
    unread: true,
  },
  {
    id: '2',
    title: 'New Customer Registered',
    message: 'A new customer "Maria Santos" has joined.',
    time: '15 mins ago',
    type: 'user',
    unread: true,
  },
  {
    id: '3',
    title: 'Stock Alert',
    message: 'Salmon Sushi Roll is running low on stock.',
    time: '1 hour ago',
    type: 'system',
    unread: false,
  },
  {
    id: '4',
    title: 'Payment Completed',
    message: 'Payment for Order #ORD1024 has been verified.',
    time: '2 hours ago',
    type: 'success',
    unread: false,
  },
];

type NotificationPanelProps = {
  isOpen: boolean;
  onClose: () => void;
  notifications?: Notification[];
};

export const NotificationPanel: React.FC<NotificationPanelProps> = ({
  isOpen,
  onClose,
  notifications: propsNotifications,
}) => {
  const { t } = useTranslation();

  const defaultNotifications: Notification[] = [
    {
      id: '1',
      title: t('notifications.new_order_title'),
      message: t('notifications.new_order_message'),
      time: t('notifications.time_2_mins_ago'),
      type: 'order',
      unread: true,
    },
    {
      id: '2',
      title: t('notifications.new_customer_title'),
      message: t('notifications.new_customer_message'),
      time: t('notifications.time_15_mins_ago'),
      type: 'user',
      unread: true,
    },
    {
      id: '3',
      title: t('notifications.stock_alert_title'),
      message: t('notifications.stock_alert_message'),
      time: t('notifications.time_1_hour_ago'),
      type: 'system',
      unread: false,
    },
    {
      id: '4',
      title: t('notifications.payment_completed_title'),
      message: t('notifications.payment_completed_message'),
      time: t('notifications.time_2_hours_ago'),
      type: 'success',
      unread: false,
    },
  ];

  const notifications = propsNotifications || defaultNotifications;

  const unreadCount = notifications.filter((n) => n.unread).length;

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/20 z-[60]"
          />

          {/* Side Panel */}
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 25, stiffness: 200 }}
            className="fixed top-0 right-0 h-full w-96 bg-white shadow-2xl z-[70] flex flex-col"
          >
            <div className="p-6 border-b border-gray-100 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-brand-orange/10 rounded-xl flex items-center justify-center text-brand-orange">
                  <Bell size={20} />
                </div>
                <div>
                  <h3 className="text-lg font-bold">{t('notifications.title')}</h3>
                  <p className="text-xs text-brand-muted font-medium">
                    {t('notifications.unread_messages', { count: unreadCount })}
                  </p>
                </div>
              </div>
              <button
                onClick={onClose}
                className="p-2 hover:bg-gray-100 rounded-lg transition-colors text-brand-muted cursor-pointer"
              >
                <X size={20} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto custom-scrollbar p-4 space-y-3">
              {notifications.length > 0 ? (
                notifications.map((notification) => (
                  <div
                    key={notification.id}
                    className={cn(
                      'p-4 rounded-2xl transition-all cursor-pointer border border-transparent hover:border-brand-orange/10 hover:bg-brand-orange/5',
                      notification.unread ? 'bg-brand-orange/5' : 'bg-white',
                    )}
                  >
                    <div className="flex gap-4">
                      <div
                        className={cn(
                          'w-10 h-10 rounded-xl flex items-center justify-center shrink-0',
                          notification.type === 'order' && 'bg-blue-100 text-blue-600',
                          notification.type === 'user' && 'bg-purple-100 text-purple-600',
                          notification.type === 'system' && 'bg-orange-100 text-orange-600',
                          notification.type === 'success' && 'bg-green-100 text-green-600',
                        )}
                      >
                        {notification.type === 'order' && <ShoppingBag size={18} />}
                        {notification.type === 'user' && <User size={18} />}
                        {notification.type === 'system' && <Info size={18} />}
                        {notification.type === 'success' && <CheckCircle size={18} />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start justify-between mb-1">
                          <h4 className="text-sm font-bold truncate pr-2">
                            {notification.title}
                          </h4>
                          {notification.unread && (
                            <span className="w-2 h-2 bg-brand-orange rounded-full mt-1.5" />
                          )}
                        </div>
                        <p className="text-xs text-brand-muted leading-relaxed mb-2">
                          {notification.message}
                        </p>
                        <span className="text-[10px] font-bold text-brand-muted/60 uppercase tracking-wider">
                          {notification.time}
                        </span>
                      </div>
                    </div>
                  </div>
                ))
              ) : (
                <div className="flex flex-col items-center justify-center h-full text-brand-muted py-20">
                  <Bell size={48} className="mb-4 opacity-20" />
                  <p className="text-sm font-medium">{t('notifications.no_notifications')}</p>
                </div>
              )}
            </div>

            <div className="p-6 border-t border-gray-100">
              <button className="w-full py-3 bg-brand-primary text-white rounded-xl font-bold text-sm shadow-lg shadow-brand-primary/20 hover:opacity-90 transition-opacity cursor-pointer">
                {t('notifications.mark_all_as_read')}
              </button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
};
