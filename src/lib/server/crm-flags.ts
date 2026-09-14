import "server-only";
export const crmBookingEnabled = () => process.env.ADA_CRM_INTEGRATION_ENABLED === "true" && process.env.ADA_CRM_BOOKING_ENABLED === "true";
