// culqi.d.ts — Window type declarations for Culqi Checkout JS v4

interface CulqiToken {
  id: string;
  email?: string;
  [key: string]: unknown;
}

interface CulqiError {
  user_message?: string;
  merchant_message?: string;
  [key: string]: unknown;
}

interface CulqiCheckout {
  open: () => void;
  close: () => void;
  settings: (options: {
    title: string;
    currency: string;
    description: string;
    amount: number;
    order?: string;
  }) => void;
  publicKey: string;
  token: CulqiToken | null;
  error: CulqiError | null;
  getOrder?: () => CulqiToken | null;
}

declare global {
  interface Window {
    Culqi: CulqiCheckout;
    culqi: (() => void) | (() => Promise<void>) | undefined;
  }
}

export {};
