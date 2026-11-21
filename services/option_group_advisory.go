package services

import (
	"context"
	"fmt"
	"strings"
	"time"

	"prophet-trader/database"
)

// Phase C, Step 4 (plan 8.1 item 6): an approaching expiry with the short leg in the money is flagged. The flag is information
// only: it never closes, rolls or changes anything, never vetoes an entry, and carries no number the agent must obey.

const advisoryExpiryDays = 7

// ShortLegExpiryAdvisory returns the advisory text for a live group, or "" when there is nothing to flag. A short leg is flagged
// when it expires within advisoryExpiryDays (today included) and the underlying price puts it in the money.
func ShortLegExpiryAdvisory(legsJSON, detachedJSON string, now time.Time, underlyingPrice float64) (string, error) {
	legs, err := decodeGroupLegs(legsJSON)
	if err != nil {
		return "", err
	}
	detached, err := decodeGroupLegs(detachedJSON)
	if err != nil {
		return "", err
	}
	gone := map[string]bool{}
	for _, leg := range detached {
		gone[strings.ToUpper(strings.TrimSpace(leg.Symbol))] = true
	}
	today := time.Date(now.UTC().Year(), now.UTC().Month(), now.UTC().Day(), 0, 0, 0, 0, time.UTC)
	var notes []string
	for _, leg := range legs {
		if leg.Side != "sell" || gone[strings.ToUpper(strings.TrimSpace(leg.Symbol))] {
			continue
		}
		_, expiry, optionType, strike, ok := parseOCCOptionSymbol(leg.Symbol)
		if !ok {
			continue
		}
		days := int(expiry.Sub(today).Hours() / 24)
		if days < 0 || days > advisoryExpiryDays {
			continue
		}
		inTheMoney := (optionType == "C" && underlyingPrice > strike) || (optionType == "P" && underlyingPrice < strike)
		if !inTheMoney {
			continue
		}
		notes = append(notes, fmt.Sprintf("short leg %s expires in %d day(s) and is in the money (assignment risk)", leg.Symbol, days))
	}
	if len(notes) == 0 {
		return "", nil
	}
	return strings.Join(notes, "; ") + "; information only: nothing is closed, rolled or changed automatically", nil
}

// advise records the advisory on each live, intact group whose short leg is near expiry. It needs a fresh quote and leaves the
// existing advisory untouched when there is none (after hours). It writes only when the text changes and never places an order.
func (r *AssignmentResolver) advise(ctx context.Context, states []database.OptionGroupState) {
	for _, state := range states {
		group := state.Group
		if group == nil || state.OpenUnits <= 0 || group.Status == "broken" {
			continue
		}
		legs, err := decodeGroupLegs(group.LegsJSON)
		if err != nil {
			continue
		}
		near := false
		today := r.now().UTC().Truncate(24 * time.Hour)
		for _, leg := range legs {
			if _, expiry, _, _, ok := parseOCCOptionSymbol(leg.Symbol); ok && leg.Side == "sell" {
				if days := int(expiry.Sub(today).Hours() / 24); days >= 0 && days <= advisoryExpiryDays {
					near = true
				}
			}
		}
		next := ""
		if near {
			bid, ask, quotedAt, err := r.Broker.LatestStockQuote(ctx, group.Underlying)
			if err != nil || quotedAt.IsZero() || r.now().Sub(quotedAt) > resolverQuoteAge || bid <= 0 || ask <= 0 {
				continue // no fresh quote: leave the advisory as it is
			}
			if next, err = ShortLegExpiryAdvisory(group.LegsJSON, group.DetachedLegsJSON, r.now(), (bid+ask)/2); err != nil {
				continue
			}
		}
		if next == group.Advisory {
			continue
		}
		updated := *group
		updated.Advisory = next
		_ = r.Store.SaveOptionGroup(&updated) // information only: a failed write is retried on the next pass
	}
}
