# sma history search

Search everything the project already wrote down: the coordination journal, the plan records, the session transcripts and the lesson bodies.

## en
`sma history search <word...>` answers the question "have we been here before?" without you opening four different piles by hand. Four books, one run:

- `journal` the coordination journal: who claimed what, when, and what collided;
- `exec` the plan-execution records: which task started, finished or blocked;
- `transcript` the vendor's session transcripts, the raw text of past sessions;
- `lesson` the memory corpus, read WHOLE, prose included.

Every line of the answer names its source, its file and its moment, so a hit is something you can go and open rather than something you have to trust.

There is no derived index behind this and there will not be one. A native scan across hundreds of megabytes of transcripts takes well under a second, and a second big artifact would only bring its own staleness and its own repair. The transcripts are streamed line by line, newest file first, and the scan stops opening files as soon as the limit is met, so a narrow question never pays for the whole pile.

`--limit N` caps each book separately, not the total. One shared ceiling would go almost entirely to the transcripts, which outweigh the other three by orders of magnitude, and the answer would come from one book while looking like it came from four.

Matching is by word, not by substring: `pel` will not find `pelican`, and Cyrillic is a word like any other. Several words mean every one of them must be on the line.

Secrets: transcripts hold whatever was printed in a session, so every fragment of the answer, from every book, goes through the same credential screen the profile uses. A key-shaped run is replaced whole. What it cannot catch is short secrets and word-shaped passwords, which have no shape to recognise, so read the output before you paste it into a report.

Missing transcript directory, or no hits at all: both are an honest empty answer and exit 0. Neither is a mistake you made.

## ru
`sma history search <слово...>` отвечает на вопрос «мы это уже проходили?», не заставляя Вас открывать руками четыре разные кучи. Четыре книги, один прогон:

- `journal` журнал координации: кто что занял, когда, и где случилось столкновение;
- `exec` записи исполнения планов: какая задача началась, закончилась или встала;
- `transcript` стенограммы сессий вендора, сырой текст прошлых разговоров;
- `lesson` корпус памяти, читается ЦЕЛИКОМ, вместе с телом заметки.

Каждая строка ответа называет источник, файл и момент, поэтому находку можно пойти и открыть, а не поверить ей на слово.

Производного индекса за этим нет и не будет. Естественный скан по сотням мегабайт стенограмм укладывается заметно меньше чем в секунду, а второй большой артефакт принёс бы только собственное протухание и собственный ремонт. Стенограммы читаются потоково, построчно, от свежих файлов к старым, и скан перестаёт открывать файлы, как только набран лимит, поэтому узкий вопрос не платит за всю кучу.

`--limit N` ограничивает каждую книгу по отдельности, а не сумму. Один общий потолок почти целиком достался бы стенограммам, которые тяжелее остальных трёх на порядки, и ответ пришёл бы из одной книги, выглядя как ответ из четырёх.

Совпадение считается по словам, а не по подстроке: «пели» не найдёт «пеликан», и кириллица тут слово наравне с латиницей. Несколько слов означают, что в строке должны быть все они.

Секреты: стенограммы хранят всё, что печаталось в сессии, поэтому каждый фрагмент ответа, из любой книги, проходит ту же проверку на ключеподобные строки, которой проверяется профиль. Похожий на ключ ран заменяется целиком. Чего проверка не ловит: коротких секретов и паролей-слов, у них нет формы, по которой их можно узнать, поэтому просмотрите выдачу глазами, прежде чем вкладывать её в отчёт.

Каталога стенограмм нет, или находок нет вовсе: и то и другое честный пустой ответ и код выхода 0. Ни то ни другое не Ваша ошибка.
