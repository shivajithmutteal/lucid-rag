import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'lucid-rag',
  description: 'A self-hostable, provider-agnostic, observable corporate RAG.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
