'use client';

import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { CheckCircle2, XCircle, Save, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { updateShippingSettings } from '../actions';
import { toast } from "sonner";
import { SecureInput } from './SecureInput';

interface ShippingSettingsProps {
    initialShippingKey: string;
    isConfigured: boolean;
}

export function ShippingSettings({ initialShippingKey, isConfigured }: ShippingSettingsProps) {
    const [shippingKey, setShippingKey] = useState(initialShippingKey);
    const [isEditing, setIsEditing] = useState(false);
    const [isSaving, setIsSaving] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsSaving(true);

        try {
            const formData = new FormData();
            formData.append('shippingKey', shippingKey);

            await updateShippingSettings(formData);

            toast.success("Shipping settings updated successfully");
            setIsEditing(false);
        } catch {
            toast.error("Failed to save shipping settings");
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center justify-between">
                    Shipping Integration
                    {isConfigured ? (
                        <Badge variant="default" className="bg-green-500/15 text-green-500 hover:bg-green-500/25 border-green-500/20">
                            <CheckCircle2 className="w-3 h-3 mr-1" /> Active
                        </Badge>
                    ) : (
                        <Badge variant="destructive" className="bg-yellow-500/15 text-yellow-500 hover:bg-yellow-500/25 border-yellow-500/20">
                            <XCircle className="w-3 h-3 mr-1" /> Optional
                        </Badge>
                    )}
                </CardTitle>
                <CardDescription>
                    Configure your Komerce API key for shipping cost calculation (optional).
                </CardDescription>
            </CardHeader>
            <CardContent>
                <form onSubmit={handleSubmit} className="space-y-4">
                    <div className="space-y-2">
                        <Label htmlFor="shipping-key">Komerce API Key 🔐</Label>
                        <SecureInput
                            id="shipping-key"
                            value={shippingKey}
                            onChange={setShippingKey}
                            disabled={!isEditing}
                            placeholder="Enter Komerce API Key"
                        />
                        <p className="text-xs text-muted-foreground">
                            This is optional. Only needed if you use shipping cost calculation features.
                        </p>
                    </div>

                    <div className="flex justify-end gap-2 pt-2">
                        {isEditing ? (
                            <>
                                <Button
                                    type="button"
                                    variant="outline"
                                    onClick={() => {
                                        setIsEditing(false);
                                        setShippingKey(initialShippingKey);
                                    }}
                                    disabled={isSaving}
                                >
                                    Cancel
                                </Button>
                                <Button type="submit" disabled={isSaving}>
                                    {isSaving ? (
                                        <>
                                            <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Saving...
                                        </>
                                    ) : (
                                        <>
                                            <Save className="w-4 h-4 mr-2" /> Save Changes
                                        </>
                                    )}
                                </Button>
                            </>
                        ) : (
                            <Button type="button" onClick={() => setIsEditing(true)}>
                                Edit Configuration
                            </Button>
                        )}
                    </div>
                </form>
            </CardContent>
        </Card>
    );
}
