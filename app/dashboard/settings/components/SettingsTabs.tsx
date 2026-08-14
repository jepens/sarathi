'use client';

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MessageSquare, Bot, Package, Settings, Building2, Zap } from "lucide-react";

interface SettingsTabsProps {
    businessProfileTab: React.ReactNode;
    whatsappTab: React.ReactNode;
    quickRepliesTab: React.ReactNode;
    aiTab: React.ReactNode;
    shippingTab: React.ReactNode;
    systemMessageTab: React.ReactNode;
}

export function SettingsTabs({ businessProfileTab, whatsappTab, quickRepliesTab, aiTab, shippingTab, systemMessageTab }: SettingsTabsProps) {
    return (
        <Tabs defaultValue="business" className="w-full">
            <TabsList className="grid w-full grid-cols-6">
                <TabsTrigger value="business" className="flex items-center gap-2">
                    <Building2 className="w-4 h-4" />
                    <span className="hidden sm:inline">Profil Bisnis</span>
                </TabsTrigger>
                <TabsTrigger value="whatsapp" className="flex items-center gap-2">
                    <MessageSquare className="w-4 h-4" />
                    <span className="hidden sm:inline">WhatsApp</span>
                </TabsTrigger>
                <TabsTrigger value="quick-replies" className="flex items-center gap-2">
                    <Zap className="w-4 h-4" />
                    <span className="hidden sm:inline">Balasan Cepat</span>
                </TabsTrigger>
                <TabsTrigger value="ai" className="flex items-center gap-2">
                    <Bot className="w-4 h-4" />
                    <span className="hidden sm:inline">AI</span>
                </TabsTrigger>
                <TabsTrigger value="shipping" className="flex items-center gap-2">
                    <Package className="w-4 h-4" />
                    <span className="hidden sm:inline">Shipping</span>
                </TabsTrigger>
                <TabsTrigger value="system" className="flex items-center gap-2">
                    <Settings className="w-4 h-4" />
                    <span className="hidden sm:inline">System</span>
                </TabsTrigger>
            </TabsList>

            <TabsContent value="business" className="mt-6">
                {businessProfileTab}
            </TabsContent>

            <TabsContent value="whatsapp" className="mt-6">
                {whatsappTab}
            </TabsContent>

            <TabsContent value="quick-replies" className="mt-6">
                {quickRepliesTab}
            </TabsContent>

            <TabsContent value="ai" className="mt-6">
                {aiTab}
            </TabsContent>

            <TabsContent value="shipping" className="mt-6">
                {shippingTab}
            </TabsContent>

            <TabsContent value="system" className="mt-6">
                {systemMessageTab}
            </TabsContent>
        </Tabs>
    );
}
