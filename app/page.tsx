"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ArrowRight, Bot, LineChart, MessageSquare, ShoppingBag, Sparkles } from "lucide-react";
import { motion } from "framer-motion";
import dynamic from "next/dynamic";

// Dynamic import for WebGL fluid animation
const LiquidEther = dynamic(() => import("@/components/LiquidEther"), {
  ssr: false,
});

export default function Home() {
  const container = {
    hidden: { opacity: 0 },
    show: {
      opacity: 1,
      transition: {
        staggerChildren: 0.1
      }
    }
  };

  const item = {
    hidden: { opacity: 0, y: 20 },
    show: { opacity: 1, y: 0 }
  };

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground overflow-hidden selection:bg-primary/20">
      {/* Liquid Ether Background Effect */}
      <div className="fixed inset-0 z-10 pointer-events-none">
        <LiquidEther
          colors={['#5227FF', '#FF9FFC', '#B19EEF']}
          mouseForce={20}
          cursorSize={100}
          isViscous={false}
          viscous={30}
          iterationsViscous={32}
          iterationsPoisson={32}
          resolution={0.5}
          isBounce={false}
          autoDemo={true}
          autoSpeed={0.5}
          autoIntensity={2.2}
          takeoverDuration={0.25}
          autoResumeDelay={3000}
          autoRampDuration={0.6}
        />
      </div>

      {/* Ambient Background Effects */}
      <div className="fixed inset-0 z-[-1] pointer-events-none">
        <div className="absolute top-[-20%] left-[-10%] h-[600px] w-[600px] rounded-full bg-primary/10 blur-[120px] opacity-50" />
        <div className="absolute bottom-[-20%] right-[-10%] h-[600px] w-[600px] rounded-full bg-blue-500/10 blur-[120px] opacity-30" />
      </div>

      <header className="sticky top-0 z-50 w-full border-b border-border/40 bg-background/80 backdrop-blur-md supports-[backdrop-filter]:bg-background/60">
        <div className="container mx-auto flex h-16 max-w-screen-xl items-center justify-between px-4">
          <div className="flex items-center space-x-2">
            <div className="bg-primary/10 p-2 rounded-lg">
              <Bot className="h-6 w-6 text-primary" />
            </div>
            <span className="font-bold text-lg tracking-tight">Sahabat UMKM</span>
          </div>
          <nav className="flex items-center gap-4">
            <Link href="/login">
              <Button variant="ghost" size="sm" className="hidden sm:flex">
                Sign In
              </Button>
            </Link>
            <Link href="/login">
              <Button size="sm" className="shadow-md shadow-blue-500/20 transition-all hover:shadow-blue-500/40 hover:bg-primary/90">
                Get Started
              </Button>
            </Link>
          </nav>
        </div>
      </header>

      <main className="flex-1">
        <section className="relative pt-20 pb-32 md:pt-32 md:pb-40 overflow-hidden">
          <motion.div
            variants={container}
            initial="hidden"
            animate="show"
            className="container mx-auto flex max-w-screen-xl flex-col items-center gap-8 text-center relative z-10 px-4"
          >
            <motion.div variants={item} className="inline-flex items-center rounded-full border border-primary/20 bg-primary/5 px-3 py-1 text-sm font-medium text-primary backdrop-blur-sm">
              <Sparkles className="mr-2 h-3.5 w-3.5" />
              <span>Now with WhatsApp Integration</span>
            </motion.div>

            <motion.h1 variants={item} className="font-heading text-4xl sm:text-6xl md:text-7xl font-bold tracking-tight text-transparent bg-clip-text bg-gradient-to-br from-foreground to-foreground/70 max-w-4xl">
              AI-Powered Sales Assistant <br className="hidden sm:inline" />
              for Indonesian MSMEs
            </motion.h1>

            <motion.p variants={item} className="max-w-2xl leading-normal text-muted-foreground sm:text-xl sm:leading-8">
              Automate your sales, manage inventory, and close more deals on WhatsApp with an intelligent AI assistant that understands your business context.
            </motion.p>

            <motion.div variants={item} className="flex flex-col sm:flex-row gap-4 w-full sm:w-auto">
              <Link href="/login">
                <Button size="lg" className="h-12 px-8 w-full sm:w-auto text-base font-semibold shadow-lg shadow-blue-500/20 hover:shadow-blue-500/40 hover:bg-primary/90 transition-all hover:scale-105">
                  Start for Free <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              </Link>
              <Link href="#features">
                <Button variant="outline" size="lg" className="h-12 px-8 w-full sm:w-auto text-base hover:bg-secondary/50 border-primary/20">
                  Learn More
                </Button>
              </Link>
            </motion.div>
          </motion.div>
        </section>

        <section id="features" className="py-12 md:py-24 lg:py-32">
          <div className="container mx-auto max-w-screen-xl px-4 space-y-12">
            <div className="mx-auto flex max-w-3xl flex-col items-center space-y-4 text-center">
              <h2 className="font-heading text-3xl leading-[1.1] sm:text-3xl md:text-5xl font-bold">
                Everything you need to grow
              </h2>
              <p className="max-w-2xl leading-normal text-muted-foreground sm:text-lg sm:leading-7">
                Powerful features designed to help you manage your business efficiently while providing a premium experience to your customers.
              </p>
            </div>

            <div className="mx-auto grid justify-center gap-6 sm:grid-cols-2 md:grid-cols-3 max-w-5xl">
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: 0.1 }}
                className="group relative overflow-hidden rounded-2xl border bg-background/50 p-2 hover:border-primary/50 transition-colors duration-300"
              >
                <div className="flex h-[200px] flex-col justify-between rounded-xl bg-gradient-to-b from-background to-secondary/20 p-6 transition-all group-hover:bg-secondary/30">
                  <div className="rounded-full bg-primary/10 w-12 h-12 flex items-center justify-center group-hover:scale-110 transition-transform duration-300">
                    <MessageSquare className="h-6 w-6 text-primary" />
                  </div>
                  <div className="space-y-2">
                    <h3 className="font-bold text-xl">Smart Chat</h3>
                    <p className="text-sm text-muted-foreground">
                      Engage customers with natural, persuasive conversations directly on WhatsApp.
                    </p>
                  </div>
                </div>
              </motion.div>

              <motion.div
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: 0.2 }}
                className="group relative overflow-hidden rounded-2xl border bg-background/50 p-2 hover:border-primary/50 transition-colors duration-300"
              >
                <div className="flex h-[200px] flex-col justify-between rounded-xl bg-gradient-to-b from-background to-secondary/20 p-6 transition-all group-hover:bg-secondary/30">
                  <div className="rounded-full bg-primary/10 w-12 h-12 flex items-center justify-center group-hover:scale-110 transition-transform duration-300">
                    <ShoppingBag className="h-6 w-6 text-primary" />
                  </div>
                  <div className="space-y-2">
                    <h3 className="font-bold text-xl">Product Management</h3>
                    <p className="text-sm text-muted-foreground">
                      Manage your inventory and products with a simple, intuitive dashboard.
                    </p>
                  </div>
                </div>
              </motion.div>

              <motion.div
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: 0.3 }}
                className="group relative overflow-hidden rounded-2xl border bg-background/50 p-2 hover:border-primary/50 transition-colors duration-300"
              >
                <div className="flex h-[200px] flex-col justify-between rounded-xl bg-gradient-to-b from-background to-secondary/20 p-6 transition-all group-hover:bg-secondary/30">
                  <div className="rounded-full bg-primary/10 w-12 h-12 flex items-center justify-center group-hover:scale-110 transition-transform duration-300">
                    <LineChart className="h-6 w-6 text-primary" />
                  </div>
                  <div className="space-y-2">
                    <h3 className="font-bold text-xl">Sales Insights</h3>
                    <p className="text-sm text-muted-foreground">
                      Track your performance and optimize your sales strategy with real-time data.
                    </p>
                  </div>
                </div>
              </motion.div>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-border/40 bg-background/50 backdrop-blur-sm py-8">
        <div className="container mx-auto max-w-screen-xl flex flex-col items-center justify-between gap-4 md:h-16 md:flex-row px-4">
          <p className="text-center text-sm leading-loose text-muted-foreground md:text-left">
            Built with ❤️ by{" "}
            <a
              href="https://sailendra.co.id/"
              target="_blank"
              rel="noreferrer"
              className="font-medium underline underline-offset-4 hover:text-primary transition-colors"
            >
              Sailendra Organizer
            </a>
            .
          </p>
          <div className="flex gap-4 text-sm text-muted-foreground">
            <Link href="#" className="hover:text-foreground transition-colors">Privacy Policy</Link>
            <Link href="#" className="hover:text-foreground transition-colors">Terms of Service</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
