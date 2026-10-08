import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createTheme, ThemeProvider } from '@mui/material/styles';
import { LocalizationProvider } from '@mui/x-date-pickers';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import { BrowserRouter } from 'react-router-dom';
import { UserProvider } from './context/UserContext.tsx';
import { installAuthInterceptor } from './utils/authInterceptor.ts';
import './i18n';
import App from './App.tsx';
import './index.css';
import 'react-datepicker/dist/react-datepicker.css';
import './styles/react-datepicker-multi.css';

// Install before any component fetches, so an expired session on ANY
// authenticated request forces a re-login instead of a raw error toast.
installAuthInterceptor();

const theme = createTheme({
  palette: {
    primary: {
      main: '#f97316',
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider theme={theme}>
      <LocalizationProvider dateAdapter={AdapterDayjs}>
        <BrowserRouter>
          <UserProvider>
            <App />
          </UserProvider>
        </BrowserRouter>
      </LocalizationProvider>
    </ThemeProvider>
  </StrictMode>,
);
