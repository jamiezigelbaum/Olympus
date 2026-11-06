package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"sort"
	"strings"
	"time"

	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	waLog "go.mau.fi/whatsmeow/util/log"
)

type availableChat struct {
	ChatScope string `json:"chat_scope"`
	Kind      string `json:"kind"`
	Title     string `json:"title"`
}

type availableChats struct {
	Event    string          `json:"event"`
	Coverage string          `json:"coverage"`
	Dialogs  []availableChat `json:"dialogs"`
}

// The caller must stop its capture client first: WhatsApp replaces concurrent
// connections using the same linked-device session. No message/history handler
// is registered, and no spool or message content is read or written here.
func runListChatsMode(ctx context.Context, container *sqlstore.Container) error {
	device, err := container.GetFirstDevice(ctx)
	if err != nil {
		return errors.New("session_store_failed")
	}
	if device == nil || device.ID == nil {
		return errors.New("session_not_paired")
	}
	client := newWhatsmeowClient(device, waLog.Noop)
	defer client.Disconnect()
	stopCancellation := context.AfterFunc(ctx, client.Disconnect)
	defer stopCancellation()
	if err := client.ConnectContext(ctx); err != nil {
		return errors.New("connect_failed")
	}
	if !waitForPairingAuthentication(ctx, func() bool { return client.IsConnected() && client.IsLoggedIn() }, 20*time.Second) {
		return errors.New("authorization_not_confirmed")
	}
	contacts, err := device.Contacts.GetAllContacts(ctx)
	if err != nil {
		return errors.New("contact_list_failed")
	}
	groups, err := client.GetJoinedGroups(ctx)
	if err != nil {
		return errors.New("group_list_failed")
	}
	if err := json.NewEncoder(os.Stdout).Encode(chatListReceipt(contacts, groups)); err != nil {
		return errors.New("chat_list_output_failed")
	}
	return nil
}

func chatListReceipt(contacts map[types.JID]types.ContactInfo, groups []*types.GroupInfo) availableChats {
	byScope := make(map[string]availableChat)
	add := func(jid types.JID, kind, title string) {
		if jid.User == "" {
			return
		}
		// Provider JIDs use numeric users (legacy groups may contain a dash).
		// Reject malformed identifiers instead of normalizing them into a scope.
		for _, char := range jid.User {
			if (char < '0' || char > '9') && !(jid.Server == types.GroupServer && char == '-') {
				return
			}
		}
		scope := "whatsapp.personal:chat:" + normalizeChatJID(jid.String())
		// Names are display-only metadata; strip control whitespace and bound output.
		title = sanitizePreviewField(strings.Join(strings.Fields(title), " "), 256)
		byScope[scope] = availableChat{ChatScope: scope, Kind: kind, Title: title}
	}
	for jid, contact := range contacts {
		if jid.Server != types.DefaultUserServer && jid.Server != types.HiddenUserServer {
			continue
		}
		title := contact.FullName
		if title == "" {
			title = contact.FirstName
		}
		if title == "" {
			title = contact.PushName
		}
		if title == "" {
			title = contact.BusinessName
		}
		add(jid, "dm", title)
	}
	for _, group := range groups {
		if group != nil && group.JID.Server == types.GroupServer {
			add(group.JID, "group", group.Name)
		}
	}
	dialogs := make([]availableChat, 0, len(byScope))
	for _, dialog := range byScope {
		dialogs = append(dialogs, dialog)
	}
	sort.Slice(dialogs, func(i, j int) bool { return dialogs[i].ChatScope < dialogs[j].ChatScope })
	return availableChats{Event: "dialogs", Coverage: "contacts_and_joined_groups", Dialogs: dialogs}
}
