// League / Hall of Fame for opponent diversity.
//
// Maintains a small pool (up to N) of past policy snapshots so the current agent
// faces a *non-stationary distribution* of opponents. Without this, self-play
// can collapse into a narrow strategy that exploits the current opponent only.
//
// The league is updated when the agent passes a quality gate (beats the prior
// median league member by some margin). This is the AlphaStar / OpenAI Five
// recipe stripped to its essentials.
(function(root, factory) {
    const exp = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = exp;
    else root.RLLeague = exp;
})(typeof self !== 'undefined' ? self : this, function() {

class League {
    constructor(maxSize = 10) {
        this.maxSize = maxSize;
        this.entries = []; // { weights, generation, fitness }
    }

    add(serialized, generation, fitness) {
        this.entries.push({ weights: serialized, generation, fitness });
        if (this.entries.length > this.maxSize) {
            // Drop the lowest-fitness entry, keeping the most recent regardless
            // (so we never lose the latest snapshot).
            const latest = this.entries[this.entries.length - 1];
            const rest = this.entries.slice(0, -1);
            rest.sort((a, b) => a.fitness - b.fitness);
            rest.shift();
            this.entries = [...rest, latest];
        }
    }

    sample() {
        if (this.entries.length === 0) return null;
        return this.entries[(Math.random() * this.entries.length) | 0];
    }

    size() { return this.entries.length; }

    serialize() {
        return { maxSize: this.maxSize, entries: this.entries };
    }

    loadFrom(obj) {
        this.maxSize = obj.maxSize || this.maxSize;
        this.entries = obj.entries || [];
    }
}

return { League };

});
