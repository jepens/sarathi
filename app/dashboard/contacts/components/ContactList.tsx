'use client';

import { useEffect, useState, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Search, Edit2, Trash2, User } from 'lucide-react';
import { toast } from 'sonner';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";


interface Contact {
    phone_number: string;
    contact_name: string | null;
    last_message_at: string;
}

export function ContactList() {
    const [contacts, setContacts] = useState<Contact[]>([]);
    const [search, setSearch] = useState('');
    const [loading, setLoading] = useState(true);

    // Edit Dialog State
    const [isEditOpen, setIsEditOpen] = useState(false);
    const [selectedContact, setSelectedContact] = useState<Contact | null>(null);
    const [editName, setEditName] = useState('');

    // Delete Dialog State
    const [isDeleteOpen, setIsDeleteOpen] = useState(false);
    const [contactToDelete, setContactToDelete] = useState<Contact | null>(null);

    const supabase = createClient();

    const fetchContacts = useCallback(async () => {
        const { data, error } = await supabase
            .from('whatsapp_chats')
            .select('phone_number, contact_name, last_message_at')
            .order('last_message_at', { ascending: false });

        if (error) {
            console.error('Error fetching contacts:', error);
            toast.error('Failed to load contacts');
        } else {
            setContacts(data || []);
        }
        setLoading(false);
    }, [supabase]);

    useEffect(() => {
        fetchContacts();
    }, [fetchContacts]);

    const openEditDialog = (contact: Contact) => {
        setSelectedContact(contact);
        setEditName(contact.contact_name || '');
        setIsEditOpen(true);
    };

    const openDeleteDialog = (contact: Contact) => {
        setContactToDelete(contact);
        setIsDeleteOpen(true);
    };

    const handleSaveEdit = async () => {
        if (!selectedContact) return;

        try {
            const { error } = await supabase
                .from('whatsapp_chats')
                .update({ contact_name: editName })
                .eq('phone_number', selectedContact.phone_number);

            if (error) throw error;

            setContacts(contacts.map(c =>
                c.phone_number === selectedContact.phone_number
                    ? { ...c, contact_name: editName }
                    : c
            ));

            setIsEditOpen(false);
            toast.success('Contact name updated');
        } catch (error) {
            console.error('Error updating contact:', error);
            toast.error('Failed to update contact name');
        }
    };

    const handleDelete = async () => {
        if (!contactToDelete) return;

        try {
            // We only remove the contact name, preserving the chat history.
            const { error } = await supabase
                .from('whatsapp_chats')
                .update({ contact_name: null })
                .eq('phone_number', contactToDelete.phone_number);

            if (error) throw error;

            setContacts(contacts.map(c =>
                c.phone_number === contactToDelete.phone_number
                    ? { ...c, contact_name: null }
                    : c
            ));
            setIsDeleteOpen(false);
            toast.success('Contact name removed');
        } catch (error) {
            console.error('Error removing contact name:', error);
            toast.error('Failed to remove contact name');
        }
    };

    const filteredContacts = contacts.filter(contact =>
        contact.phone_number.includes(search) ||
        (contact.contact_name && contact.contact_name.toLowerCase().includes(search.toLowerCase()))
    );

    function formatTime(dateString: string) {
        const date = new Date(dateString);
        return date.toLocaleDateString('id-ID', {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    }

    return (
        <div className="flex flex-col h-full bg-white rounded-lg border shadow-sm">
            <div className="p-4 border-b flex items-center justify-between">
                <h2 className="text-lg font-semibold">Contacts</h2>
                <div className="relative w-64">
                    <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input
                        placeholder="Search contacts..."
                        className="pl-10"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                    />
                </div>
            </div>

            <div className="flex-1 overflow-y-auto">
                {loading ? (
                    <div className="p-8 text-center text-muted-foreground">Loading contacts...</div>
                ) : filteredContacts.length === 0 ? (
                    <div className="p-8 text-center text-muted-foreground">No contacts found</div>
                ) : (
                    <table className="w-full text-sm text-left">
                        <thead className="text-xs text-gray-700 uppercase bg-gray-50">
                            <tr>
                                <th className="px-6 py-3">Name</th>
                                <th className="px-6 py-3">Phone Number</th>
                                <th className="px-6 py-3">Last Active</th>
                                <th className="px-6 py-3 text-right">Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {filteredContacts.map((contact) => (
                                <tr key={contact.phone_number} className="bg-white border-b hover:bg-gray-50">
                                    <td className="px-6 py-4 font-medium text-gray-900">
                                        <div className="flex items-center gap-2">
                                            <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center text-primary">
                                                <User className="h-4 w-4" />
                                            </div>
                                            <span>{contact.contact_name || '-'}</span>
                                        </div>
                                    </td>
                                    <td className="px-6 py-4 text-gray-500">
                                        {contact.phone_number}
                                    </td>
                                    <td className="px-6 py-4 text-gray-500">
                                        {formatTime(contact.last_message_at)}
                                    </td>
                                    <td className="px-6 py-4 text-right">
                                        <div className="flex items-center justify-end gap-2">
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                onClick={() => openEditDialog(contact)}
                                                title="Edit Name"
                                            >
                                                <Edit2 className="h-4 w-4 text-gray-500" />
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                onClick={() => openDeleteDialog(contact)}
                                                title="Delete Contact"
                                            >
                                                <Trash2 className="h-4 w-4 text-red-500" />
                                            </Button>
                                        </div>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>

            {/* Edit Dialog */}
            <Dialog open={isEditOpen} onOpenChange={setIsEditOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Edit Contact Name</DialogTitle>
                        <DialogDescription>
                            Add a friendly name for this contact. This name will appear in your chats.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-4 py-4">
                        <div className="grid grid-cols-4 items-center gap-4">
                            <Label htmlFor="name" className="text-right">
                                Name
                            </Label>
                            <Input
                                id="name"
                                value={editName}
                                onChange={(e) => setEditName(e.target.value)}
                                className="col-span-3"
                                placeholder="e.g. Budi Santoso"
                            />
                        </div>
                        <div className="grid grid-cols-4 items-center gap-4">
                            <Label htmlFor="phone" className="text-right">
                                Phone
                            </Label>
                            <Input
                                id="phone"
                                value={selectedContact?.phone_number || ''}
                                disabled
                                className="col-span-3 bg-muted"
                            />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setIsEditOpen(false)}>Cancel</Button>
                        <Button onClick={handleSaveEdit}>Save Changes</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Delete Dialog */}
            <Dialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Remove Contact Name</DialogTitle>
                        <DialogDescription>
                            Are you sure you want to remove the name for this contact? The chat history will be preserved.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="py-4">
                        <p className="text-sm text-muted-foreground">
                            Phone: <span className="font-medium text-foreground">{contactToDelete?.phone_number}</span>
                        </p>
                        {contactToDelete?.contact_name && (
                            <p className="text-sm text-muted-foreground">
                                Name: <span className="font-medium text-foreground">{contactToDelete.contact_name}</span>
                            </p>
                        )}
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setIsDeleteOpen(false)}>Cancel</Button>
                        <Button variant="destructive" onClick={handleDelete}>Remove Name</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
