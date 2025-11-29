'use client';

import { useState } from 'react';
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Eye, EyeOff } from "lucide-react";

interface SecureInputProps {
    id: string;
    value: string;
    onChange: (value: string) => void;
    disabled?: boolean;
    placeholder?: string;
}

export function SecureInput({ id, value, onChange, disabled, placeholder }: SecureInputProps) {
    const [showValue, setShowValue] = useState(false);

    return (
        <div className="flex gap-2">
            <Input
                id={id}
                type={showValue ? "text" : "password"}
                value={value}
                onChange={(e) => onChange(e.target.value)}
                disabled={disabled}
                className="font-mono text-sm"
                placeholder={placeholder}
            />
            {!disabled && (
                <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={() => setShowValue(!showValue)}
                    title={showValue ? "Hide" : "Show"}
                >
                    {showValue ? (
                        <EyeOff className="w-4 h-4" />
                    ) : (
                        <Eye className="w-4 h-4" />
                    )}
                </Button>
            )}
        </div>
    );
}
