// Web Worker for parallel training match evaluation
// Imports game code and runs headless matches, returning fitness scores

importScripts('physics.js', 'entities.js', 'ai.js', 'learning-ai.js');

// Listen for match batches from main thread
self.onmessage = function(e) {
    const { type, data } = e.data;

    if (type === 'evaluate') {
        const field = new Field(data.field.w, data.field.h, data.field.mapType);
        const results = [];

        // Build a lookup of all agent weights for self-play
        const allAgentWeights = {};
        if (data.allAgents) {
            for (const a of data.allAgents) {
                allAgentWeights[a.index] = a.weights;
            }
        }

        for (const agentData of data.agents) {
            const nn = new NeuralNetwork([20, 24, 12, 5]);
            nn.deserialize(agentData.weights);
            const agent = new LearningAI(nn);
            agent.fitness = 0;
            let matchCount = 0;

            // Sparring matches against scripted/learned opponents
            for (const oppData of data.opponents) {
                const opp = createOpponent(oppData);
                const match = new HeadlessMatch(field);

                if (oppData.playAsBlue) {
                    const result = match.run(opp, agent);
                    agent.fitness += result.blueFitness;
                } else {
                    const result = match.run(agent, opp);
                    agent.fitness += result.redFitness;
                }
                matchCount++;
            }

            // Self-play pairs
            if (data.selfPlayPairs) {
                for (const pair of data.selfPlayPairs) {
                    if (pair.redIndex === agentData.index || pair.blueIndex === agentData.index) {
                        const partnerIdx = pair.redIndex === agentData.index ? pair.blueIndex : pair.redIndex;
                        const partnerWeights = allAgentWeights[partnerIdx];
                        if (partnerWeights) {
                            const partnerNN = new NeuralNetwork([20, 24, 12, 5]);
                            partnerNN.deserialize(partnerWeights);
                            const partner = new LearningAI(partnerNN);
                            const match = new HeadlessMatch(field);

                            if (pair.redIndex === agentData.index) {
                                const result = match.run(agent, partner);
                                agent.fitness += result.redFitness;
                            } else {
                                const result = match.run(partner, agent);
                                agent.fitness += result.blueFitness;
                            }
                            matchCount++;
                        }
                    }
                }
            }

            agent.fitness /= Math.max(matchCount, 1);
            results.push({ index: agentData.index, fitness: agent.fitness });
        }

        self.postMessage({ type: 'results', results });
    }
};

function createOpponent(oppData) {
    switch (oppData.type) {
        case 'chaser': return new ChaserAI();
        case 'random': return new RandomAI();
        case 'defender': return new DefenderAI();
        case 'easy': return new AIController('easy');
        case 'medium': return new AIController('medium');
        case 'learned':
            const nn = new NeuralNetwork([20, 24, 12, 5]);
            nn.deserialize(oppData.weights);
            return new LearningAI(nn);
        default: return new ChaserAI();
    }
}
