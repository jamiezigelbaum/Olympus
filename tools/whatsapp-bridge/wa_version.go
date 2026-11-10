package main

import (
	"context"
	"log"
	"net/http"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/store"
)

// useCurrentWAVersion asks web.whatsapp.com for the current WhatsApp Web
// version before pairing and uses it when it is newer than the one this
// build pinned (#760). WhatsApp refuses to link a device that reports a stale
// version ("Couldn't link device"), and the pin goes stale between releases.
// Any failure keeps the pinned version.
func useCurrentWAVersion(ctx context.Context) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	latest, err := whatsmeow.GetLatestVersion(ctx, &http.Client{Timeout: 5 * time.Second})
	if err != nil || latest == nil {
		log.Printf("olympus-whatsapp-bridge: could not check the current WhatsApp Web version; using the pinned %s", store.GetWAVersion())
		return
	}
	if newerWAVersion(*latest, store.GetWAVersion()) {
		store.SetWAVersion(*latest)
		log.Printf("olympus-whatsapp-bridge: using the current WhatsApp Web version %s", latest)
	}
}

func newerWAVersion(candidate, pinned store.WAVersionContainer) bool {
	if candidate.IsZero() {
		return false
	}
	for i := range candidate {
		if candidate[i] != pinned[i] {
			return candidate[i] > pinned[i]
		}
	}
	return false
}
