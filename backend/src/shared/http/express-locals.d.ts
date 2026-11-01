declare global {
  namespace Express {
    interface Locals {
      /** Correlation id of the current request (`X-Request-Id`). */
      requestId: string;
      /** Valid `X-Request-Id` sent by the client, logged but never echoed. */
      clientRequestId?: string;
    }
  }
}

export {};
