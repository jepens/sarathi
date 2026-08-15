'use client';

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MessageSquare, Bot, Package, Settings, Building2, Zap, Tag, Palette } from "lucide-react";

interface SettingsTabsProps {
    businessProfileTab: React.ReactNode;
    whatsappTab: React.ReactNode;
    quickRepliesTab: React.ReactNode;
    labelsTab: React.ReactNode;
    appearanceTab: React.ReactNode;
    aiTab: React.ReactNode;
    shippingTab: React.ReactNode;
    systemMessageTab: React.ReactNode;
}

export function SettingsTabs({ businessProfileTab, whatsappTab, quickRepliesTab, labelsTab, appearanceTab, aiTab, shippingTab, systemMessageTab }: SettingsTabsProps) {
    return (
        <Tabs defaultValue="business" className="w-full">
            {/* flex + overflow-x-auto so the tabs never overlap: each grows to
                fill on wide screens (flex-1) but never shrinks below its label
                (min-w-max), and the row scrolls horizontally when too narrow
                instead of colliding. */}
            <TabsList className="flex w-full justify-start overflow-x-auto">
                <TabsTrigger value="business" className="flex flex-1 min-w-max items-center gap-2">
                    <Building2 className="w-4 h-4" />
                    <span className="hidden sm:inline">Profil Bisnis</span>
                </TabsTrigger>
                <TabsTrigger value="whatsapp" className="flex flex-1 min-w-max items-center gap-2">
                    <MessageSquare className="w-4 h-4" />
                    <span className="hidden sm:inline">WhatsApp</span>
                </TabsTrigger>
                <TabsTrigger value="quick-replies" className="flex flex-1 min-w-max items-center gap-2">
                    <Zap className="w-4 h-4" />
                    <span className="hidden sm:inline">Balasan Cepat</span>
                </TabsTrigger>
                <TabsTrigger value="labels" className="flex flex-1 min-w-max items-center gap-2">
                    <Tag className="w-4 h-4" />
                    <span className="hidden sm:inline">Label</span>
                </TabsTrigger>
                <TabsTrigger value="ai" className="flex flex-1 min-w-max items-center gap-2">
                    <Bot className="w-4 h-4" />
                    <span className="hidden sm:inline">AI</span>
                </TabsTrigger>
                <TabsTrigger value="shipping" className="flex flex-1 min-w-max items-center gap-2">
                    <Package className="w-4 h-4" />
                    <span className="hidden sm:inline">Shipping</span>
                </TabsTrigger>
                <TabsTrigger value="system" className="flex flex-1 min-w-max items-center gap-2">
                    <Settings className="w-4 h-4" />
                    <span className="hidden sm:inline">System</span>
                </TabsTrigger>
                <TabsTrigger value="appearance" className="flex flex-1 min-w-max items-center gap-2">
                    <Palette className="w-4 h-4" />
                    <span className="hidden sm:inline">Tampilan</span>
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

            <TabsContent value="labels" className="mt-6">
                {labelsTab}
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

            <TabsContent value="appearance" className="mt-6">
                {appearanceTab}
            </TabsContent>
        </Tabs>
    );
}
