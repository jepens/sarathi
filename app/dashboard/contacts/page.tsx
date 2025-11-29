import { ContactList } from './components/ContactList';

export default function ContactsPage() {
    return (
        <div className="h-full">
            <div className="mb-6">
                <h1 className="text-2xl font-bold tracking-tight">Contacts</h1>
                <p className="text-muted-foreground">
                    Manage your WhatsApp contacts and their names.
                </p>
            </div>
            <div className="h-[calc(100vh-12rem)]">
                <ContactList />
            </div>
        </div>
    );
}
