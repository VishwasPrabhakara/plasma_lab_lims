// Input validators. Keep these small and pure — easy to port, easy to unit test.

export function validEmail(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(e || "").trim());
}

export function validPhone(cc, phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  return /^\+\d{1,4}$/.test(String(cc || "")) && digits.length >= 6 && digits.length <= 15;
}
