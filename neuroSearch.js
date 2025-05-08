async function sendSearchRequest(userRequest) {
    try {
        const response = await fetch("https://yandex.ru/neuralsearch/api/send_to_dialog", {
            "headers": {
                "accept": "*/*",
                "content-type": "application/json",
                "accept-encoding": "gzip, deflate, br",
                "connection": "keep-alive"
            },
            "body": JSON.stringify({
                "UserRequest": userRequest + " " + "Отвечай чётко и развёрнуто в стиле Preplaxity, но строго по теме, НИКОГДА НЕ ПИШИ Возможно имелось в виду и тд. в конце ответа не приводи ссылки СТРОГО",
                "EditLastMessageMode": false
            }),
            "method": "POST"
        });

        const data = await response.json();
        const rmid = data.ResponseMessageId;
        return rmid;
    } catch (error) {
        console.error('Ошибка при выполнении запроса:', error);
        throw error;
    }
}
async function getResponse(rmid) {
    try {
        const maxAttempts = 6; // Максимальное количество попыток (30 секунд при задержке в 5 секунд)
        let attempt = 0;

        while (attempt < maxAttempts) {
            const response = await fetch("https://yandex.ru/neuralsearch/api/get_fresh_message", {
                "headers": {
                    "accept": "*/*",
                    "content-type": "application/json",
                    "accept-encoding": "gzip, deflate, br",
                    "connection": "keep-alive"
                },
                "body": `{"ResponseMessageId":"${rmid}"}`,
                "method": "POST"
            });

            const data = await response.json();
            const links = data.LinksData || [];

            if (data.TargetMarkdownText) {
                return { responseText: data.TargetMarkdownText };
            }

            attempt++;
            if (attempt < maxAttempts) {
                await new Promise(resolve => setTimeout(resolve, 7000)); // Задержка 5 секунд
                console.log(`Ожидание ответа от нейросети... Попытка ${attempt + 1} из ${maxAttempts}`);
                console.log('Ссылки:', links || 'Нет ссылки');
            }
        }

        throw new Error('Превышено время ожидания ответа от нейросети')
    } catch (error) {
        console.error('Ошибка при выполнении запроса:', error);
        throw error;
    }
}
module.exports = {
    sendSearchRequest,
    getResponse
};
