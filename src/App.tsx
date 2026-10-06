import React from "react";
import { BrowserRouter as Router, Routes, Route } from "react-router-dom";
import LandingPage from "./pages/LandingPage";
import ManageBookingPage from "./pages/ManageBookingPage";
import BookingConfirmationPreview from "./pages/BookingConfirmationPreview";
import BookingPage from "./pages/BookingPage";
import DashboardPage from "./pages/DashboardPage";
import SnakePage from "./pages/SnakePage";

function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/login" element={<DashboardPage />} />
        <Route path="/signup" element={<LandingPage />} />
        <Route path="/booking/confirmation-preview" element={<BookingConfirmationPreview />} />
        <Route path="/booking/manage" element={<ManageBookingPage />} />
        <Route path="/booking" element={<BookingPage />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/snake" element={<SnakePage />} />
        <Route path="*" element={<LandingPage />} />
      </Routes>
    </Router>
  );
}

export default App;
