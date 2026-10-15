"use client"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { toast } from "sonner"

export default function DesignSystemClient() {
    return (
        <div className="min-h-screen bg-background p-10 space-y-10">
            <div className="space-y-2">
                <h1 className="text-3xl font-bold tracking-tight text-foreground">Design System</h1>
                <p className="text-muted-foreground">Linear Aesthetic Verification</p>
            </div>

            <section className="space-y-4">
                <h2 className="text-xl font-semibold text-foreground">Buttons</h2>
                <div className="flex flex-wrap gap-4">
                    <Button>Default</Button>
                    <Button variant="secondary">Secondary</Button>
                    <Button variant="outline">Outline</Button>
                    <Button variant="ghost">Ghost</Button>
                    <Button variant="destructive">Destructive</Button>
                    <Button variant="link">Link</Button>
                </div>
            </section>

            <section className="space-y-4">
                <h2 className="text-xl font-semibold text-foreground">Cards (Bento Grid Style)</h2>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    <Card>
                        <CardHeader>
                            <CardTitle>Card Title</CardTitle>
                            <CardDescription>Card Description</CardDescription>
                        </CardHeader>
                        <CardContent>
                            <p>This is a simple card with the Linear aesthetic. Subtle border, dark background.</p>
                        </CardContent>
                        <CardFooter>
                            <Button variant="outline" size="sm">Action</Button>
                        </CardFooter>
                    </Card>

                    <Card className="bg-muted/50">
                        <CardHeader>
                            <CardTitle>Muted Card</CardTitle>
                            <CardDescription>Using muted background</CardDescription>
                        </CardHeader>
                        <CardContent>
                            <p>Content goes here.</p>
                        </CardContent>
                    </Card>

                    <Card className="border-primary/20">
                        <CardHeader>
                            <CardTitle>Accent Border</CardTitle>
                        </CardHeader>
                        <CardContent>
                            <p>Card with a slight primary border accent.</p>
                        </CardContent>
                    </Card>
                </div>
            </section>

            <section className="space-y-4">
                <h2 className="text-xl font-semibold text-foreground">Toast</h2>
                <Button
                    variant="outline"
                    onClick={() =>
                        toast("Event has been created", {
                            description: "Sunday, December 03, 2023 at 9:00 AM",
                            action: {
                                label: "Undo",
                                onClick: () => console.log("Undo"),
                            },
                        })
                    }
                >
                    Show Toast
                </Button>
            </section>
        </div>
    )
}
