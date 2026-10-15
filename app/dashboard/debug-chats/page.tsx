import { notFound } from 'next/navigation';
import DebugChatsClient from './DebugChatsClient';

// Developer-only inspection page (raw chats + messages): never served in
// production builds. The sidebar link is already development-only.
export default function DebugChatsPage() {
    if (process.env.NODE_ENV === 'production') notFound();
    return <DebugChatsClient />;
}
