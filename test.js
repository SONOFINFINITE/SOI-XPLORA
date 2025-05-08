const readline = require('readline');
const { sendSearchRequest, getResponse } = require('./neuroSearch');

async function testNeuroSearch() {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    try {
        // Запрашиваем пользовательский ввод
        const userInput = await new Promise((resolve) => {
            rl.question('Введите ваш запрос: ', (answer) => {
                resolve(answer);
            });
        });

        // Отправляем запрос и получаем rmid
        const rmid = await sendSearchRequest(userInput);

        // Получаем ответ с использованием rmid
        const { responseText } = await getResponse(rmid);

        // Выводим результаты
        console.log('\nТекст ответа:', responseText);

    } catch (error) {
        console.error('Произошла ошибка:', error);
    } finally {
        rl.close();
    }
}

testNeuroSearch();