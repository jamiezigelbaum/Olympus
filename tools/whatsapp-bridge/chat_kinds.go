package main

import (
	"context"
	"sync"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/types"
)

// Chat kinds in an approved capture scope (#1075). A kind token in the
// allowed list ("kind:dm") covers every chat of that kind, including chats
// started after pairing; an exact JID covers that chat only. Choosing chats
// never sets a privacy tier: each message is still judged on its own.
const (
	chatKindDM        = "dm"
	chatKindGroup     = "group"
	chatKindCommunity = "community"
	kindTokenPrefix   = "kind:"
)

// validChatKind is the closed set the bridge can tell apart.
func validChatKind(kind string) bool {
	return kind == chatKindDM || kind == chatKindGroup || kind == chatKindCommunity
}

// groupIsCommunity reports whether a group belongs to a community: the
// community itself (its parent) or a group linked under one.
func groupIsCommunity(info *types.GroupInfo) bool {
	return info != nil && (info.IsParent || !info.LinkedParentJID.IsEmpty())
}

// communityLookup answers whether a group chat belongs to a community.
type communityLookup func(chat types.JID) (bool, error)

// captureAllowed decides one chat against the approved scope. Status
// broadcasts and other non-chat servers are never matched by a kind. A group
// is a community or a plain group; when only one of the two kinds is on, the
// lookup decides, and an unknown answer fails closed.
func captureAllowed(chat types.JID, allowed map[string]struct{}, isCommunity communityLookup) bool {
	if allowed == nil {
		return true
	}
	if _, all := allowed["*"]; all {
		return true
	}
	if _, ok := allowed[chat.String()]; ok {
		return true
	}
	_, dm := allowed[kindTokenPrefix+chatKindDM]
	_, group := allowed[kindTokenPrefix+chatKindGroup]
	_, community := allowed[kindTokenPrefix+chatKindCommunity]
	switch chat.Server {
	case types.DefaultUserServer, types.HiddenUserServer:
		return dm && chat.User != ""
	case types.GroupServer:
		if chat.User == "" || (!group && !community) {
			return false
		}
		if group && community {
			return true
		}
		if isCommunity == nil {
			return false
		}
		inCommunity, err := isCommunity(chat)
		if err != nil {
			return false
		}
		return inCommunity == community
	}
	return false
}

// communityCache asks WhatsApp once per group whether it belongs to a
// community, and remembers the answer for the life of the process. A failed
// lookup is not remembered, so the next message asks again.
type communityCache struct {
	mu     sync.Mutex
	known  map[string]bool
	lookup func(chat types.JID) (*types.GroupInfo, error)
}

func newCommunityCache(lookup func(chat types.JID) (*types.GroupInfo, error)) *communityCache {
	return &communityCache{known: make(map[string]bool), lookup: lookup}
}

func (c *communityCache) isCommunity(chat types.JID) (bool, error) {
	key := chat.String()
	c.mu.Lock()
	known, ok := c.known[key]
	c.mu.Unlock()
	if ok {
		return known, nil
	}
	info, err := c.lookup(chat)
	if err != nil {
		return false, err
	}
	answer := groupIsCommunity(info)
	c.mu.Lock()
	c.known[key] = answer
	c.mu.Unlock()
	return answer, nil
}

var (
	clientCommunitiesMu sync.Mutex
	clientCommunities   = map[*whatsmeow.Client]*communityCache{}
)

// communityLookupFor is the cached lookup for one capture client, or nil
// without a client (a nil lookup fails closed when it is needed).
func communityLookupFor(ctx context.Context, client *whatsmeow.Client) communityLookup {
	if client == nil {
		return nil
	}
	clientCommunitiesMu.Lock()
	defer clientCommunitiesMu.Unlock()
	cache, ok := clientCommunities[client]
	if !ok {
		cache = newCommunityCache(func(chat types.JID) (*types.GroupInfo, error) {
			return client.GetGroupInfo(ctx, chat)
		})
		clientCommunities[client] = cache
	}
	return cache.isCommunity
}
