const SUIT_CARDS = {
    circle: [1, 2, 3, 4, 5, 7, 8, 10, 11, 12, 13, 14],
    triangle: [1, 2, 3, 4, 5, 7, 8, 10, 11, 12, 13, 14],
    cross: [1, 2, 3, 5, 7, 10, 11, 13, 14],
    square: [1, 2, 3, 5, 7, 10, 11, 13, 14],
    star: [1, 2, 3, 4, 5, 7, 8],
};

const generateWhotDeck = (ruleVersion = "rule1") => {
    const deck = [];
    for (const suit in SUIT_CARDS) {
        SUIT_CARDS[suit].forEach((num) => {
            deck.push({
                id: `${suit}-${num}`,
                suit: suit,
                number: num,
                rank: `${suit}-${num}`,
            });
        });
    }
    const whotCount = ruleVersion === "rule1" ? 5 : 0;
    for (let i = 1; i <= whotCount; i++) {
        deck.push({
            id: `whot-${i}`,
            suit: "whot",
            number: 20,
            rank: `whot-${i}`,
        });
    }
    return deck;
};

const shuffleArray = (array) => {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
};

export const initializeGameData = (gameType, player1, player2) => {
    const updateData = {};

    if (gameType === 'ayo') {
        updateData.board = Array(12).fill(4);
        updateData.currentTurn = player1.id;
    } else if (gameType === 'ludo') {
        const HOUSE_POS = -1;
        const p1Color = 'blue';
        const p2Color = 'green';
        const level = 2;

        updateData.board = {
            players: [
                {
                    id: 'p1',
                    color: p1Color,
                    seeds: Array.from({ length: 4 }).map((_, i) => ({ id: `${p1Color}-${i}`, position: HOUSE_POS, landingPos: HOUSE_POS, animationDelay: 0 })),
                },
                {
                    id: 'p2',
                    color: p2Color,
                    seeds: Array.from({ length: 4 }).map((_, i) => ({ id: `${p2Color}-${i}`, position: HOUSE_POS, landingPos: HOUSE_POS, animationDelay: 0 })),
                },
            ],
            currentPlayerIndex: 0,
            dice: [],
            diceUsed: [],
            waitingForRoll: true,
            winner: null,
            log: ['Game Started'],
            level: level,
        };
        updateData.currentTurn = player1.id;
    } else if (gameType === 'whot') {
        const ruleVersion = "rule1";
        const fullDeck = shuffleArray(generateWhotDeck(ruleVersion));
        const startingHand = 5;

        const players = [
            { id: player1.id, name: player1.name, hand: fullDeck.slice(0, startingHand) },
            { id: player2.id, name: player2.name, hand: fullDeck.slice(startingHand, startingHand * 2) }
        ];

        const market = fullDeck.slice(startingHand * 2);
        const specialNums = [1, 2, 5, 8, 14, 20];
        let firstCardIndex = market.findIndex(c => !specialNums.includes(c.number));
        if (firstCardIndex === -1) firstCardIndex = 0;

        const firstCard = market[firstCardIndex];
        const initialMarket = [
            ...market.slice(0, firstCardIndex),
            ...market.slice(firstCardIndex + 1)
        ];

        updateData.board = {
            players,
            market: initialMarket,
            pile: [firstCard],
            currentPlayer: 0,
            direction: 1,
            ruleVersion,
            pendingPick: 0,
            calledSuit: null,
            lastPlayedCard: firstCard,
            pendingAction: null,
            mustPlayNormal: false,
            winner: null,
            allCards: fullDeck
        };
        updateData.currentTurn = player1.id;
    }

    return updateData;
};
