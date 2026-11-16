package app.purss.device

import org.junit.Assert.assertEquals
import org.junit.Test

class BadgeTest {
    @Test
    fun theNewestCarriesWhatTheOthersDont() {
        assertEquals(listOf(12), Badge.numbers(12, 1))
        assertEquals(listOf(1, 1, 10), Badge.numbers(12, 3))
        assertEquals(12, Badge.numbers(12, 3).sum())
    }

    @Test
    fun noNumbersWhenTheNotificationsAlreadyReachTheCount() {
        assertEquals(listOf(0, 0, 0), Badge.numbers(3, 3))
        assertEquals(listOf(0, 0), Badge.numbers(1, 2))
        assertEquals(listOf(0), Badge.numbers(0, 1))
    }

    @Test
    fun nothingToNumberWithoutNotifications() {
        assertEquals(emptyList<Int>(), Badge.numbers(5, 0))
    }
}
