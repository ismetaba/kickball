// Trained AI models that ship with the game, plus skills the player has
// trained further in the AI Lab.
//
//   models/expert.json   the AI behind Expert difficulty: one full-match
//                        policy ({ type: 'match', policy }), the coach driving
//                        the four skills ({ type: 'skills' }), or a full-match
//                        policy with some skills taking over in their own
//                        situations ({ type: 'hybrid', policy, skills: [...] })
//   models/skills.json   the four skill policies and their drill success rates
//
// window.AIModels:
//   ready                     settles once both files have loaded (or failed)
//   expertAgent()             a fresh Expert AI, or null while nothing is loaded
//   skillsAgent()             the coach + skills (the player's own where trained)
//   skillModel(name)          the model a skill uses: the player's own, else bundled
//   bundledSkill(name)        the shipped model for a skill (or null)
//   saveLocalSkill(name, m) / clearLocalSkill(name) / hasLocalSkill(name)
(function() {
    const LOCAL_KEY = 'kickzone-skill-';
    const SKILLS = RLSkills.SKILLS;

    let expert = null;
    let skills = null;
    let expertFactory = null;
    let skillsFactory = null;

    const load = (url) => fetch(url).then(r => (r.ok ? r.json() : null)).catch(() => null);
    const ready = Promise.all([load('models/expert.json'), load('models/skills.json')]).then(([e, s]) => {
        expert = e;
        skills = s;
    });

    function readLocal(name) {
        try {
            const raw = localStorage.getItem(LOCAL_KEY + name);
            return raw ? JSON.parse(raw) : null;
        } catch (e) {
            return null;
        }
    }

    function bundledSkill(name) {
        return (skills && skills.skills && skills.skills[name]) || null;
    }

    function skillModel(name) {
        return readLocal(name) || bundledSkill(name);
    }

    function skillsAgent() {
        if (!skillsFactory) {
            const models = {};
            for (const name of SKILLS) {
                models[name] = skillModel(name);
                if (!models[name]) return null;
            }
            try {
                skillsFactory = RLSkills.SkillAgent.factory({ skills: models });
            } catch (e) {
                console.warn('[AIModels] skill models unusable', e);
                return null;
            }
        }
        return skillsFactory();
    }

    function expertAgent() {
        if (!expert) return null;
        if (expert.type === 'skills') return skillsAgent();
        if (!expertFactory) {
            try {
                expertFactory = expert.type === 'hybrid'
                    ? RLSkills.SkillAgent.factory(
                        { skills: Object.fromEntries(SKILLS.map(n => [n, bundledSkill(n)]).filter(([, m]) => m)) },
                        { base: expert, only: expert.skills })
                    : RLSkills.MatchAgent.factory(expert);
            } catch (e) {
                console.warn('[AIModels] expert model unusable', e);
                return null;
            }
        }
        return expertFactory();
    }

    window.AIModels = {
        ready,
        expertAgent,
        skillsAgent,
        skillModel,
        bundledSkill,
        hasLocalSkill: (name) => !!readLocal(name),
        saveLocalSkill(name, model) {
            try {
                localStorage.setItem(LOCAL_KEY + name, JSON.stringify(model));
            } catch (e) {
                console.warn('[AIModels] could not save skill', name, e);
                return false;
            }
            skillsFactory = null;
            return true;
        },
        clearLocalSkill(name) {
            try { localStorage.removeItem(LOCAL_KEY + name); } catch (e) {}
            skillsFactory = null;
        },
        get expertInfo() {
            return expert;
        },
    };
})();
