import { notFound } from 'next/navigation';
import DesignSystemClient from './DesignSystemClient';

// Developer-only component showcase: never served in production builds.
export default function DesignSystemPage() {
    if (process.env.NODE_ENV === 'production') notFound();
    return <DesignSystemClient />;
}
