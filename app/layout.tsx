import type { Metadata } from "next";
import { headers } from "next/headers";
import Script from "next/script";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import "./modelcut.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("host") ?? "localhost:3000";
  const protocol = host.startsWith("localhost") ? "http" : "https";
  const metadataBase = new URL(`${protocol}://${host}`);
  const description =
    "Split 3MF and STL models into validated, print-ready pieces entirely in your browser.";
  return {
    metadataBase,
    title: "ModelCut Studio — Private 3D Model Splitter",
    description,
    icons: {
      icon: "/favicon.svg",
      shortcut: "/favicon.svg",
    },
    openGraph: {
      title: "ModelCut Studio",
      description: "Split locally. Print confidently.",
      type: "website",
      images: [{ url: "/og.png", width: 1731, height: 909 }],
    },
    twitter: {
      card: "summary_large_image",
      title: "ModelCut Studio",
      description: "Split locally. Print confidently.",
      images: ["/og.png"],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <Script id="insert-before-diagnostics" strategy="beforeInteractive">
          {`(() => {
  if (!new URLSearchParams(location.search).has("debugInsertBefore")) return;

  const prototype = Node.prototype;
  const originalInsertBefore = prototype.insertBefore;
  let lastAction = { type: "initial page load", elapsedMs: performance.now() };
  const describe = (node) => {
    if (!node) return null;
    return {
      nodeType: node.nodeType,
      nodeName: node.nodeName,
      id: node.id || null,
      className: typeof node.className === "string" ? node.className : null,
      connected: node.isConnected,
      html: node.nodeType === Node.ELEMENT_NODE ? node.outerHTML.slice(0, 600) : null,
      text: node.nodeType === Node.TEXT_NODE ? node.textContent.slice(0, 200) : null,
    };
  };

  for (const eventName of ["pointerdown", "click", "keydown", "drop", "change"]) {
    document.addEventListener(eventName, (event) => {
      lastAction = {
        type: eventName,
        target: describe(event.target),
        elapsedMs: performance.now(),
      };
    }, true);
  }

  for (const eventName of ["DOMContentLoaded", "load"]) {
    window.addEventListener(eventName, () => {
      console.info("[insertBefore diagnostics] lifecycle", {
        event: eventName,
        elapsedMs: performance.now(),
        readyState: document.readyState,
      });
    }, { once: true });
  }

  const relevantSelector = ".modelcut-canvas, .modelcut-viewport-host, .modelcut-empty-viewport, .modelcut-webgl-error";
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      const changed = [...record.addedNodes, ...record.removedNodes].flatMap((node) => {
        if (!(node instanceof Element)) return [];
        return [
          ...(node.matches(relevantSelector) ? [node] : []),
          ...node.querySelectorAll(relevantSelector),
        ].map(describe);
      });
      if (changed.length) {
        console.info("[insertBefore diagnostics] viewport DOM mutation", {
          elapsedMs: performance.now(),
          target: describe(record.target),
          added: record.addedNodes.length,
          removed: record.removedNodes.length,
          changed,
        });
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  prototype.insertBefore = function (node, referenceNode) {
    try {
      return originalInsertBefore.call(this, node, referenceNode);
    } catch (error) {
      if (error?.name === "NotFoundError") {
        console.error("[insertBefore diagnostics] NotFoundError", {
          elapsedMs: performance.now(),
          readyState: document.readyState,
          lastAction,
          error,
          errorStack: error.stack,
          insertBeforeCallStack: new Error("insertBefore call site").stack,
          parent: describe(this),
          node: describe(node),
          referenceNode: describe(referenceNode),
          referenceParent: describe(referenceNode?.parentNode),
          referenceIsChildOfParent: referenceNode?.parentNode === this,
          parentChildren: [...this.childNodes].map(describe),
        });
      }
      throw error;
    }
  };

  console.info("[insertBefore diagnostics] enabled", {
    startedAt: new Date().toISOString(),
    readyState: document.readyState,
    note: "Reproduce once before interaction, then after loading/using the 3D editor.",
  });
})();`}
        </Script>
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
